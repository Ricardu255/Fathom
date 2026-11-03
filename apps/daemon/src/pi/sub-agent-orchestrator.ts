import { randomUUID } from "node:crypto";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  HarnessEventType,
  type KnowledgeSearch,
  type SubAgentQueuedData,
  type SubAgentStatus,
  type SubAgentTerminalData,
  type Usage,
} from "@harness/core";
import { sandboxBlockedNetworkReason, sandboxBlockedToolReason } from "@harness/sandbox";
import { createWorkspaceTools } from "@harness/tools";
import type { HarnessConfig } from "../config";
import { buildSubAgentPrompt, type SubAgentType } from "../prompts";
import { SkillRegistry } from "../skills/skill-registry";
import { createSkillTools } from "../skills/skill-tools";
import type { HarnessDatabase } from "../storage/database";
import { createCommandSandboxRunner } from "./command-sandbox";
import { createReadDocumentTool, createViewPdfPageTool } from "./document-tools";
import type { PiBridgeEmit } from "./event-bridge";
import { configureMockStream, type PiModelSetup } from "./model";
import { SubAgentEventBridge } from "./sub-agent-bridge";
import { ToolExecutionGuard } from "./tool-guard";
import { type PiToolApprovalInput, toPiTools } from "./tools";
import { loadAgentsContext } from "./workspace-context";
import { workspaceWriteCoordinator } from "./workspace-write-coordinator";

const MAX_ACTIVE_CHILDREN = 3;
const MAX_TASK_CHARS = 20_000;
const MAX_MESSAGE_CHARS = 10_000;
const READ_ONLY_TOOLS = new Set([
  "list_files",
  "read_file",
  "search_text",
  "search_knowledge",
  "web_fetch",
  "web_search",
  "view_image",
  "read_document",
  "view_pdf_page",
  "find_skill",
  "get_skill",
  "load_skill",
]);

export interface SpawnSubAgentInput {
  agentType?: SubAgentType | undefined;
  dependsOn?: readonly string[] | undefined;
  name?: string | undefined;
  task: string;
}

export interface WorkflowNodeInput {
  agentType?: SubAgentType | undefined;
  dependsOn?: readonly string[] | undefined;
  id: string;
  task: string;
  title?: string | undefined;
}

export interface SubAgentResult {
  agentType: SubAgentType;
  errorCode?: string;
  executionId: string;
  name: string;
  resultSummary?: string;
  status: SubAgentStatus | "running";
  usage?: Usage;
}

export interface SubAgentOrchestratorOptions {
  config: HarnessConfig;
  database: HarnessDatabase;
  emit: PiBridgeEmit;
  getRunId: () => string | null;
  logger: {
    error(details: Record<string, unknown>, message: string): void;
    warn(details: Record<string, unknown>, message: string): void;
  };
  modelSetup: PiModelSetup;
  protectedPaths: readonly string[];
  requestApproval: (
    input: PiToolApprovalInput,
    signal: AbortSignal | undefined,
    executionId?: string,
    options?: { force?: boolean },
  ) => Promise<boolean>;
  searchKnowledge: KnowledgeSearch;
  workspaceRoot: string;
}

interface Execution {
  abort: AbortController;
  agentType: SubAgentType;
  completion: Promise<SubAgentResult>;
  dependsOn: string[];
  eventChain: Promise<void>;
  id: string;
  name: string;
  resolveCompletion: (result: SubAgentResult) => void;
  result: SubAgentResult | null;
  runId: string | null;
  session: AgentSession | null;
  started: boolean;
  budgetExceeded: "run-duration" | "run-tokens" | "tokens" | null;
  inputTokens: number;
  outputTokens: number;
  task: string;
  timedOut: boolean;
  timer: NodeJS.Timeout | null;
  unsubscribe: (() => void) | null;
}

/** 单个父 Session 的子 Agent 执行图：支持依赖、看板状态与失败向下游传播。 */
export class SubAgentOrchestrator {
  private readonly executions = new Map<string, Execution>();
  private readonly toolGuard = new ToolExecutionGuard();
  private aborting = false;
  private runDurationTimer: NodeJS.Timeout | null = null;
  private runExhausted = false;
  private runInputTokens = 0;
  private runOutputTokens = 0;
  private scheduling = false;

  public constructor(private readonly options: SubAgentOrchestratorOptions) {}

  /** 新 Run 开始时清掉上一轮已完成的执行记录，预算按 Run 计算。 */
  public beginRun(): void {
    this.toolGuard.reset();
    this.aborting = false;
    this.runExhausted = false;
    this.runInputTokens = 0;
    this.runOutputTokens = 0;
    if (this.runDurationTimer !== null) clearTimeout(this.runDurationTimer);
    this.runDurationTimer = null;
    for (const [id, execution] of this.executions) {
      if (execution.result !== null) this.executions.delete(id);
    }
    const maxDuration = this.options.config.subAgentRunMaxDurationMs;
    if (maxDuration > 0) {
      this.runDurationTimer = setTimeout(() => {
        this.runExhausted = true;
        for (const execution of this.executions.values()) {
          if (execution.result === null && execution.budgetExceeded === null) {
            execution.budgetExceeded = "run-duration";
          }
        }
        void this.abortAll();
      }, maxDuration);
      this.runDurationTimer.unref();
    }
  }

  public get activeCount(): number {
    return [...this.executions.values()].filter(
      (execution) => execution.started && execution.result === null,
    ).length;
  }

  public get totalCount(): number {
    return this.executions.size;
  }

  public async spawn(input: SpawnSubAgentInput): Promise<{ executionId: string; name: string }> {
    const task = input.task.trim();
    this.validateTask(task);
    const dependsOn = [...(input.dependsOn ?? [])];
    for (const dependency of dependsOn) {
      if (!this.executions.has(dependency)) {
        throw new Error(`依赖的子 Agent 不存在: ${dependency}`);
      }
    }
    if (this.runExhausted) throw new Error("本轮预算已用尽，不能再启动子 Agent");
    if (this.executions.size >= this.options.config.subAgentMaxTotal) {
      throw new Error(`本轮最多启动 ${this.options.config.subAgentMaxTotal} 个子 Agent`);
    }

    const execution = this.createExecution({
      agentType: input.agentType ?? "worker",
      dependsOn,
      name: input.name?.trim() || `${input.agentType ?? "worker"}-${this.executions.size + 1}`,
      task,
    });
    this.schedule();
    return { executionId: execution.id, name: execution.name };
  }

  /** 一次提交完整 DAG：节点 id 用于表达依赖，返回每个节点的 executionId。 */
  public async runDag(
    nodes: readonly WorkflowNodeInput[],
  ): Promise<{ executionId: string; name: string; nodeId: string }[]> {
    if (nodes.length === 0 || nodes.length > this.options.config.subAgentMaxDagNodes) {
      throw new Error(`工作流节点数必须为 1-${this.options.config.subAgentMaxDagNodes}`);
    }
    const byNodeId = new Map<string, WorkflowNodeInput>();
    for (const node of nodes) {
      if (node.id.trim() === "" || byNodeId.has(node.id)) {
        throw new Error(`工作流节点 id 必须唯一且非空: ${node.id}`);
      }
      this.validateTask(node.task.trim());
      byNodeId.set(node.id, node);
    }
    for (const node of nodes) {
      for (const dependency of node.dependsOn ?? []) {
        if (!byNodeId.has(dependency)) {
          throw new Error(`节点 ${node.id} 依赖了不存在的节点: ${dependency}`);
        }
      }
    }
    detectNodeCycle(nodes);
    if (this.runExhausted) throw new Error("本轮预算已用尽，不能再启动工作流");
    if (this.executions.size + nodes.length > this.options.config.subAgentMaxTotal) {
      throw new Error(`本轮最多启动 ${this.options.config.subAgentMaxTotal} 个子 Agent`);
    }

    const idByNode = new Map(nodes.map((node) => [node.id, randomUUID()] as const));
    const created: Execution[] = [];
    for (const node of nodes) {
      const execution = this.createExecution({
        agentType: node.agentType ?? "worker",
        dependsOn: (node.dependsOn ?? []).map((dependency) => idByNode.get(dependency) ?? ""),
        executionId: idByNode.get(node.id) ?? randomUUID(),
        name: node.title?.trim() || node.id,
        task: node.task.trim(),
      });
      created.push(execution);
    }
    this.schedule();
    return created.map((execution, index) => ({
      executionId: execution.id,
      name: execution.name,
      nodeId: nodes[index]?.id ?? execution.name,
    }));
  }

  public async wait(
    executionIds: readonly string[],
    mode: "all" | "any",
    timeoutSeconds: number,
    signal: AbortSignal,
  ): Promise<SubAgentResult[]> {
    const ids = executionIds.length > 0 ? [...executionIds] : [...this.executions.keys()];
    const known = ids.filter((id) => this.executions.has(id));
    if (known.length === 0) return [];

    const promises = known.map((id) => this.executions.get(id)?.completion);
    const combined = mode === "any" ? Promise.race(promises) : Promise.all(promises);
    const timeout = delay(Math.min(timeoutSeconds, 900) * 1_000);
    const result = await Promise.race([
      combined.then(() => "settled" as const),
      timeout.then(() => "timeout" as const),
      abortPromise(signal).then(() => "aborted" as const),
    ]);
    if (result === "aborted") {
      const error = new Error("Request was aborted");
      error.name = "AbortError";
      throw error;
    }
    timeout.cancel();
    return known.map((id) => this.snapshot(id));
  }

  public async waitForAll(executionIds?: readonly string[]): Promise<SubAgentResult[]> {
    const ids = executionIds ?? [...this.executions.keys()];
    const completions = ids
      .map((id) => this.executions.get(id)?.completion)
      .filter((item): item is Promise<SubAgentResult> => item !== undefined);
    await Promise.allSettled(completions);
    return ids.map((id) => this.snapshot(id));
  }

  public async send(executionId: string, message: string): Promise<"queued" | "sent"> {
    const execution = this.requireExecution(executionId);
    if (execution.result !== null) throw new Error("子 Agent 已结束，无法继续发送消息");
    if (!execution.started) throw new Error("子 Agent 尚未开始，正在等待依赖完成");
    const session = execution.session;
    if (session === null) throw new Error("子 Agent 尚未就绪");
    const text = message.trim();
    if (text === "" || text.length > MAX_MESSAGE_CHARS) {
      throw new Error(`消息必须为 1-${MAX_MESSAGE_CHARS} 个字符`);
    }
    if (session.isStreaming) {
      await session.prompt(text, { streamingBehavior: "followUp" });
      return "queued";
    }
    void session.prompt(text).catch((error: unknown) => {
      this.options.logger.warn({ err: error, executionId }, "子 Agent 后续消息失败");
    });
    return "sent";
  }

  public async stop(executionId: string): Promise<boolean> {
    const execution = this.executions.get(executionId);
    if (execution === undefined || execution.result !== null) return false;
    if (!execution.started) {
      await this.finish(execution, "aborted", {});
      return true;
    }
    execution.abort.abort();
    await execution.session?.abort().catch(() => undefined);
    await execution.completion;
    return true;
  }

  public async abortAll(): Promise<void> {
    this.aborting = true;
    const running = [...this.executions.values()].filter((execution) => execution.result === null);
    for (const execution of running) {
      execution.abort.abort();
      if (execution.started) {
        await execution.session?.abort().catch(() => undefined);
      } else {
        await this.finish(execution, "aborted", {});
      }
    }
    await Promise.allSettled(running.map((execution) => execution.completion));
    this.aborting = false;
  }

  public async dispose(): Promise<void> {
    if (this.runDurationTimer !== null) clearTimeout(this.runDurationTimer);
    this.runDurationTimer = null;
    await this.abortAll();
    this.executions.clear();
  }

  public list(): SubAgentResult[] {
    return [...this.executions.keys()].map((id) => this.snapshot(id));
  }

  private validateTask(task: string): void {
    if (task === "" || task.length > MAX_TASK_CHARS) {
      throw new Error(`任务必须为 1-${MAX_TASK_CHARS} 个字符`);
    }
  }

  private createExecution(input: {
    agentType: SubAgentType;
    dependsOn: string[];
    executionId?: string;
    name: string;
    task: string;
  }): Execution {
    let resolveCompletion: (result: SubAgentResult) => void = () => undefined;
    const completion = new Promise<SubAgentResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const executionId = input.executionId ?? randomUUID();
    const execution: Execution = {
      abort: new AbortController(),
      agentType: input.agentType,
      completion,
      dependsOn: input.dependsOn,
      eventChain: Promise.resolve(),
      id: executionId,
      name: input.name,
      resolveCompletion,
      result: null,
      runId: this.options.getRunId(),
      session: null,
      started: false,
      budgetExceeded: null,
      inputTokens: 0,
      outputTokens: 0,
      task: input.task,
      timedOut: false,
      timer: null,
      unsubscribe: null,
    };
    this.executions.set(executionId, execution);
    void this.emitQueued(execution);
    return execution;
  }

  private async emitQueued(execution: Execution): Promise<void> {
    await this.options.emit({
      data: {
        agentType: execution.agentType,
        dependsOn: execution.dependsOn,
        executionId: execution.id,
        modelId: this.options.config.model,
        name: execution.name,
        parentExecutionId: null,
        task: execution.task,
      } satisfies SubAgentQueuedData,
      runId: execution.runId,
      type: HarnessEventType.SUBAGENT_QUEUED,
    });
  }

  private schedule(): void {
    if (this.scheduling || this.aborting) return;
    this.scheduling = true;
    try {
      let changed = true;
      while (changed) {
        changed = false;
        for (const execution of this.executions.values()) {
          if (execution.started || execution.result !== null) continue;
          const dependencies = execution.dependsOn.map((id) => this.executions.get(id));
          if (dependencies.some((dependency) => dependency === undefined)) {
            void this.finish(execution, "failed", { errorCode: "SUBAGENT_DEPENDENCY_MISSING" });
            changed = true;
            continue;
          }
          if (
            dependencies.some(
              (dependency) =>
                dependency !== undefined &&
                dependency.result !== null &&
                dependency.result.status !== "completed",
            )
          ) {
            void this.finish(execution, "failed", { errorCode: "SUBAGENT_DEPENDENCY_FAILED" });
            changed = true;
            continue;
          }
          const ready = dependencies.every(
            (dependency) => dependency?.result?.status === "completed",
          );
          if (!ready || this.activeCount >= MAX_ACTIVE_CHILDREN) continue;
          execution.started = true;
          changed = true;
          void this.start(execution);
        }
      }
    } finally {
      this.scheduling = false;
    }
  }

  private async start(execution: Execution): Promise<void> {
    await this.options.emit({
      data: {
        agentType: execution.agentType,
        dependsOn: execution.dependsOn,
        executionId: execution.id,
        modelId: this.options.config.model,
        name: execution.name,
        parentExecutionId: null,
        task: execution.task,
      },
      runId: execution.runId,
      type: HarnessEventType.SUBAGENT_STARTED,
    });
    try {
      await this.openChild(execution);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger.error({ err: error, executionId: execution.id }, "子 Agent 启动失败");
      await this.finish(execution, "failed", {
        errorCode: "SUBAGENT_START_FAILED",
        resultSummary: message.slice(0, 500),
      });
      return;
    }
    void this.run(execution);
  }

  private async openChild(execution: Execution): Promise<void> {
    const manager = SessionManager.inMemory();
    const agentsContext = await loadAgentsContext(
      this.options.workspaceRoot,
      this.options.protectedPaths,
    );
    const skillRegistry = new SkillRegistry({
      disabled: this.options.database.getDisabledSkills(),
      globalDir: this.options.config.skillsGlobalDir,
      systemDir: this.options.config.skillsSystemDir,
      workspaceRoot: this.options.workspaceRoot,
    });
    const settings = SettingsManager.create(
      this.options.workspaceRoot,
      this.options.config.piAgentDir,
    );
    const resourceLoader = new DefaultResourceLoader({
      agentDir: this.options.config.piAgentDir,
      cwd: this.options.workspaceRoot,
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
      settingsManager: settings,
      systemPrompt: buildSubAgentPrompt(
        execution.agentType,
        execution.name,
        execution.task,
        this.options.workspaceRoot,
        agentsContext,
        await skillRegistry.catalogText(),
      ),
    });
    await resourceLoader.reload();

    const tools = [
      ...createWorkspaceTools({
        commandRunner: createCommandSandboxRunner({
          config: this.options.config,
          getSettings: () => this.options.database.getSettings(),
          logger: this.options.logger,
        }),
        networkCheck: (hostname) =>
          sandboxBlockedNetworkReason(this.options.database.getSettings().sandbox, hostname),
        searxngUrl: this.options.config.searxngUrl,
        supportsImages: () => this.options.modelSetup.model.input.includes("image"),
      }),
      createReadDocumentTool(),
      createViewPdfPageTool({
        supportsImages: () => this.options.modelSetup.model.input.includes("image"),
      }),
      ...createSkillTools(skillRegistry),
    ].filter((tool) => execution.agentType === "worker" || READ_ONLY_TOOLS.has(tool.name));
    const customTools = toPiTools(tools, {
      guard: this.toolGuard,
      onResult: async ({ result }) => {
        for (const change of result.fileChanges ?? []) {
          await this.options.emit({
            data: {
              ...change,
              toolCallId: `${execution.id}:file`,
              toolName: "subagent_file_change",
            },
            runId: execution.runId,
            type: HarnessEventType.FILE_CHANGED,
          });
        }
      },
      protectedPaths: this.options.protectedPaths,
      requestApproval: (input, signal, options) =>
        this.options.requestApproval(input, signal, execution.id, options),
      sandboxBlockedReason: (toolName) =>
        sandboxBlockedToolReason(this.options.database.getSettings().sandbox, toolName),
      searchKnowledge: this.options.searchKnowledge,
      workspaceRoot: this.options.workspaceRoot,
      writeCoordinator: workspaceWriteCoordinator,
    });

    const { session } = await createAgentSession({
      agentDir: this.options.config.piAgentDir,
      cwd: this.options.workspaceRoot,
      customTools,
      model: this.options.modelSetup.model,
      modelRuntime: this.options.modelSetup.modelRuntime,
      noTools: "builtin",
      resourceLoader,
      sessionManager: manager,
      settingsManager: settings,
    });
    if (this.options.modelSetup.mock) configureMockStream(session);
    execution.session = session;
    const bridge = new SubAgentEventBridge(
      this.options.emit,
      execution.id,
      null,
      () => execution.runId,
    );
    execution.unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end") {
        const message = event.message;
        if (message.role === "assistant" && "usage" in message) {
          this.trackUsage(execution, message.usage.input, message.usage.output);
        }
      }
      execution.eventChain = execution.eventChain
        .then(() => bridge.handle(event))
        .catch((error: unknown) => {
          this.options.logger.warn(
            { err: error, executionId: execution.id },
            "子 Agent 事件投影失败",
          );
        });
    });
  }

  private async run(execution: Execution): Promise<void> {
    const session = execution.session;
    if (session === null) {
      await this.finish(execution, "failed", { errorCode: "SUBAGENT_NOT_READY" });
      return;
    }

    execution.timer = setTimeout(() => {
      execution.timedOut = true;
      void session.abort().catch(() => undefined);
    }, this.options.config.subAgentMaxDurationMs);
    execution.timer.unref();
    execution.abort.signal.addEventListener(
      "abort",
      () => {
        void session.abort().catch(() => undefined);
      },
      { once: true },
    );

    try {
      await session.prompt(execution.task);
    } catch (error: unknown) {
      if (!execution.abort.signal.aborted && !execution.timedOut) {
        this.options.logger.warn({ err: error, executionId: execution.id }, "子 Agent 运行失败");
      }
    }

    const messages = session.messages;
    const assistant = [...messages].reverse().find((message) => message.role === "assistant");
    const text =
      assistant === undefined
        ? ""
        : assistant.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n")
            .trim();
    const stats = session.getSessionStats();
    const usage: Usage | undefined =
      stats.tokens.input > 0 || stats.tokens.output > 0
        ? {
            inputTokens: stats.tokens.input,
            outputTokens: stats.tokens.output,
          }
        : undefined;

    if (execution.budgetExceeded !== null) {
      const errorCode =
        execution.budgetExceeded === "tokens"
          ? "SUBAGENT_BUDGET_TOKENS"
          : execution.budgetExceeded === "run-tokens"
            ? "SUBAGENT_BUDGET_RUN_TOKENS"
            : "SUBAGENT_BUDGET_RUN_DURATION";
      await this.finish(execution, "aborted", {
        errorCode,
        ...(usage === undefined ? {} : { usage }),
      });
      return;
    }
    if (execution.abort.signal.aborted || execution.timedOut) {
      await this.finish(execution, "aborted", {
        ...(execution.timedOut ? { errorCode: "SUBAGENT_TIMEOUT" } : {}),
        ...(usage === undefined ? {} : { usage }),
      });
      return;
    }
    if (assistant !== undefined && "stopReason" in assistant && assistant.stopReason === "error") {
      await this.finish(execution, "failed", {
        errorCode: "SUBAGENT_MODEL_FAILED",
        ...(usage === undefined ? {} : { usage }),
      });
      return;
    }
    if (text === "") {
      await this.finish(execution, "failed", {
        errorCode: "SUBAGENT_EMPTY_RESULT",
        ...(usage === undefined ? {} : { usage }),
      });
      return;
    }
    await this.finish(execution, "completed", {
      resultSummary: text.slice(0, 8_000),
      ...(usage === undefined ? {} : { usage }),
    });
  }

  private trackUsage(execution: Execution, input: number, output: number): void {
    execution.inputTokens += input;
    execution.outputTokens += output;
    this.runInputTokens += input;
    this.runOutputTokens += output;
    const childTotal = execution.inputTokens + execution.outputTokens;
    const runTotal = this.runInputTokens + this.runOutputTokens;
    const childLimit = this.options.config.subAgentMaxTokens;
    const runLimit = this.options.config.subAgentRunMaxTokens;
    if (execution.budgetExceeded === null && childLimit > 0 && childTotal >= childLimit) {
      execution.budgetExceeded = "tokens";
      execution.abort.abort();
      void execution.session?.abort().catch(() => undefined);
    }
    if (runLimit > 0 && runTotal >= runLimit && !this.runExhausted) {
      this.runExhausted = true;
      for (const item of this.executions.values()) {
        if (item.result === null && item.budgetExceeded === null) {
          item.budgetExceeded = "run-tokens";
        }
      }
      void this.abortAll();
    }
  }

  private async finish(
    execution: Execution,
    status: "aborted" | "completed" | "failed",
    input: { errorCode?: string; resultSummary?: string; usage?: Usage },
  ): Promise<SubAgentResult> {
    if (execution.result !== null) return execution.result;
    const result: SubAgentResult = {
      agentType: execution.agentType,
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      executionId: execution.id,
      name: execution.name,
      ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
      status,
      ...(input.usage === undefined ? {} : { usage: input.usage }),
    };
    execution.result = result;
    execution.resolveCompletion(result);
    try {
      await this.terminal(execution, status, input);
    } catch (error: unknown) {
      this.options.logger.error(
        { err: error, executionId: execution.id },
        "子 Agent 终态事件写入失败",
      );
    }
    if (execution.timer !== null) clearTimeout(execution.timer);
    execution.timer = null;
    execution.unsubscribe?.();
    execution.unsubscribe = null;
    execution.session?.dispose();
    execution.session = null;
    this.schedule();
    return result;
  }

  private async terminal(
    execution: Execution,
    status: "aborted" | "completed" | "failed",
    input: { errorCode?: string; resultSummary?: string; usage?: Usage },
  ): Promise<void> {
    const type =
      status === "completed"
        ? HarnessEventType.SUBAGENT_COMPLETED
        : status === "aborted"
          ? HarnessEventType.SUBAGENT_ABORTED
          : HarnessEventType.SUBAGENT_FAILED;
    await this.options.emit({
      data: {
        executionId: execution.id,
        parentExecutionId: null,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.resultSummary === undefined ? {} : { resultSummary: input.resultSummary }),
        ...(input.usage === undefined ? {} : { usage: input.usage }),
      } satisfies SubAgentTerminalData,
      runId: execution.runId,
      type,
    });
  }

  private snapshot(executionId: string): SubAgentResult {
    const execution = this.executions.get(executionId);
    if (execution === undefined) {
      return {
        agentType: "worker",
        errorCode: "SUBAGENT_NOT_FOUND",
        executionId,
        name: executionId,
        status: "failed",
      };
    }
    return (
      execution.result ?? {
        agentType: execution.agentType,
        executionId: execution.id,
        name: execution.name,
        status: execution.started ? "running" : "pending",
      }
    );
  }

  private requireExecution(executionId: string): Execution {
    const execution = this.executions.get(executionId);
    if (execution === undefined) throw new Error("子 Agent 不存在");
    return execution;
  }
}

function detectNodeCycle(nodes: readonly WorkflowNodeInput[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`工作流存在循环依赖: ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
}

interface CancelableDelay extends Promise<void> {
  cancel(): void;
}

function delay(ms: number): CancelableDelay {
  let timer: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  }) as CancelableDelay;
  promise.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
  };
  return promise;
}

function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

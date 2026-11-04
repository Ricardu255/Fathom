import type { FileChange, TodoItem } from "./events";
import type { KnowledgeSearch } from "./knowledge";
import type { MessageImage } from "./messages";
import type { ToolDefinition } from "./provider";

export interface ToolContext {
  protectedPaths?: readonly string[];
  searchKnowledge?: KnowledgeSearch;
  signal: AbortSignal;
  workspaceRoot: string;
}

export interface FileObservation {
  /** realpath 后的绝对路径，用于跨 Agent 的写锁与 observed-content 校验。 */
  path: string;
  /** 文件内容的 sha256。 */
  hash: string;
}

export interface ToolResult {
  content: string;
  fileChanges?: readonly FileChange[];
  /** 本次工具观察到的文件内容指纹；写工具写入后也应记录新指纹。 */
  observedFiles?: readonly FileObservation[];
  /** 图片结果会作为 image content 发给支持视觉的模型。 */
  images?: readonly MessageImage[];
  isError?: boolean;
  /**
   * 给程序消费者看的结构化结果。模型仍然只看到 `content`，
   * UI 与策略可以读这里而不必再解析文本。
   */
  structuredContent?: unknown;
  todos?: readonly TodoItem[];
}

/**
 * 工具行为提示，语义与 MCP 的 tool annotations 一致。
 * 它是声明而不是保证：策略侧据此决定并行度与审批提示，不能拿来当安全边界。
 */
export interface ToolAnnotations {
  /** 破坏性：可能删除或覆盖既有内容。 */
  destructive?: boolean;
  /** 幂等：同样的参数重复调用，结果一致。 */
  idempotent?: boolean;
  /** 只读：不修改工作区。 */
  readOnly?: boolean;
}

export interface Tool {
  annotations?: ToolAnnotations;
  description: string;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
  inputSchema: Record<string, unknown>;
  name: string;
  /** 解析并校验模型给出的参数；抛错会被转换为工具失败结果。 */
  parse(input: unknown): unknown;
  requiresApproval: boolean;
  summarize(input: unknown): string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  public register(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error(`工具名称重复: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public names(): readonly string[] {
    return [...this.tools.keys()];
  }

  public definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      description: tool.description,
      inputSchema: tool.inputSchema,
      name: tool.name,
    }));
  }
}

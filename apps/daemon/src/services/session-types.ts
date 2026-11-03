import type {
  AgentMessage,
  ApprovalRequestedData,
  AttachmentContextData,
  ContextCheckpoint,
  FileChange,
  HarnessEvent,
  MemoryRecalledData,
  MessageImage,
  PlanCreatedData,
  SubAgentView,
  TodoItem,
  ToolRunView,
  UsageData,
  UserInputAnswer,
  UserInputRequestedData,
} from "@harness/core";
import type { SandboxSettings } from "@harness/sandbox";
import type { HarnessSettings, SessionRecord } from "../storage/database";
import type { CheckpointDiffEntry, StoredCheckpoint } from "./context-checkpoint";

export interface QueuedInput {
  createdAt: number;
  id: string;
  text: string;
}

export interface SessionSnapshot {
  approvals: ApprovalRequestedData[];
  attachments: AttachmentContextData | null;
  compactionCount: number;
  fileChanges: FileChange[];
  isRunning: boolean;
  lastSeq: number;
  lastUsage: UsageData | null;
  memoryRecall: MemoryRecalledData | null;
  messages: AgentMessage[];
  plan: PlanCreatedData | null;
  queued: QueuedInput[];
  runId: string | null;
  session: SessionRecord;
  subAgents: SubAgentView[];
  todos: TodoItem[];
  tools: ToolRunView[];
  userInputs: UserInputRequestedData[];
}

export interface StartRunResult {
  queuedInputId?: string;
  runId?: string;
}

export interface CheckpointComparison {
  base: StoredCheckpoint;
  fields: CheckpointDiffEntry[];
  target: StoredCheckpoint;
}

export interface RewriteResult {
  queuedInputId?: string;
  runId?: string;
  session: SessionRecord;
}

export interface FileMergePreviewView {
  base: string | null;
  conflict: boolean;
  merged: string | null;
  ours: string | null;
  path: string;
  theirs: string | null;
}

export interface SessionCompareView {
  base: {
    fileChanges: FileChange[];
    messages: AgentMessage[];
    sessionId: string;
    title: string;
  };
  commonPrefix: number;
  target: {
    fileChanges: FileChange[];
    messages: AgentMessage[];
    sessionId: string;
    title: string;
  };
}

export interface WorkflowNodeSpec {
  agentType?: "explorer" | "reviewer" | "worker" | undefined;
  dependsOn?: readonly string[] | undefined;
  id: string;
  task: string;
  title?: string | undefined;
}

/** 两种引擎（builtin / pi）共享的 daemon 对外契约。 */
export interface SessionController {
  abort(sessionId: string, runId: string): boolean | Promise<boolean>;
  archiveSession(sessionId: string): void;
  close(): void | Promise<void>;
  compact(sessionId: string): Promise<void>;
  compareSessions(baseSessionId: string, targetSessionId: string): Promise<SessionCompareView>;
  mergeCode(
    targetSessionId: string,
    sourceSessionId: string,
  ): Promise<{ files: FileMergePreviewView[]; session: SessionRecord }>;
  createSession(input: {
    modelId?: string | undefined;
    providerId?: string | undefined;
    thinkingLevel?: string | undefined;
    title?: string | undefined;
    workspaceRoot?: string | undefined;
  }): Promise<SessionRecord>;
  getSession(sessionId: string): SessionRecord;
  getDisabledSkills(): string[];
  getSettings(): HarnessSettings;
  isSessionRunning(sessionId: string): boolean;
  forkSession(
    sessionId: string,
    fromTimestamp?: number,
    options?: { excludeFromTimestamp?: boolean },
  ): Promise<SessionRecord>;
  rewriteSession(
    sessionId: string,
    fromTimestamp: number,
    text: string,
    images?: readonly MessageImage[],
    planMode?: boolean,
  ): Promise<RewriteResult>;
  getSnapshot(sessionId: string): Promise<SessionSnapshot>;
  initialize(): Promise<void>;
  listQueued(sessionId: string): QueuedInput[];
  listAllowedCommandPrefixes(): string[];
  listCheckpoints(sessionId: string): Promise<StoredCheckpoint[]>;
  listSessions(includeArchived?: boolean): SessionRecord[];
  mergeSessions(targetSessionId: string, sourceSessionId: string): Promise<SessionRecord>;
  updateSessionModel(
    sessionId: string,
    providerId: string,
    modelId: string,
    thinkingLevel: string,
  ): Promise<SessionRecord>;
  previewCodeMerge(
    targetSessionId: string,
    sourceSessionId: string,
  ): Promise<FileMergePreviewView[]>;
  restoreCheckpoint(sessionId: string, checkpointId: string): Promise<ContextCheckpoint>;
  resumeSession(sessionId: string): Promise<StartRunResult>;
  restoreSession(sessionId: string): void;
  compareCheckpoints(
    sessionId: string,
    baseId: string,
    targetId: string,
  ): Promise<CheckpointComparison>;
  readEvents(sessionId: string, afterSeq: number): Promise<HarnessEvent[]>;
  removeAllowedCommandPrefix(prefix: string): string[];
  removeQueued(sessionId: string, inputId: string): Promise<boolean>;
  renameSession(sessionId: string, title: string): void;
  resolveApproval(
    sessionId: string,
    approvalId: string,
    approved: boolean,
    options?: { allowPrefix?: string; grantSession?: boolean },
  ): boolean;
  resolveUserInput(
    sessionId: string,
    inputId: string,
    answers: readonly UserInputAnswer[],
  ): Promise<boolean>;
  setApprovalMode(mode: HarnessSettings["approvalMode"]): HarnessSettings;
  setSandboxSettings(input: SandboxSettings): HarnessSettings;
  setSkillEnabled(scope: "global" | "project" | "system", id: string, enabled: boolean): string[];
  startRun(
    sessionId: string,
    text: string,
    images?: readonly MessageImage[],
    planMode?: boolean,
    attachments?: readonly string[],
  ): Promise<StartRunResult>;
  steerRun(
    sessionId: string,
    text: string,
    images?: readonly MessageImage[],
  ): Promise<"handled" | "queued">;
  startWorkflow(sessionId: string, nodes: readonly WorkflowNodeSpec[]): Promise<{ runId: string }>;
}

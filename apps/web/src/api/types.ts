import type {
  AgentMessage,
  ApprovalRequestedData,
  AttachmentContextData,
  BoardTaskView,
  ContextCheckpoint,
  FileChange,
  MemoryRecalledData,
  PlanCreatedData,
  SubAgentView,
  TodoItem,
  ToolRunView,
  UsageData,
  UserInputRequestedData,
} from "@harness/core";
import type { LiteratureReport } from "@harness/core/literature";

export interface Session {
  archivedAt: number | null;
  createdAt: number;
  id: string;
  isRunning?: boolean;
  lastSeq: number;
  modelId: string | null;
  parentSessionId: string | null;
  providerId: string | null;
  thinkingLevel: string | null;
  title: string;
  updatedAt: number;
  workspaceId: string | null;
  workspaceRoot: string;
}

export interface SkillSummary {
  description: string;
  directory?: string;
  enabled: boolean;
  id: string;
  name: string;
  scope: "global" | "project" | "system";
  skillFile?: string;
}

export interface UsageDay {
  costComplete: boolean;
  costUsd: number;
  date: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface UsageBreakdown {
  costUsd: number | null;
  inputTokens: number;
  modelId: string;
  outputTokens: number;
  providerId: string;
  requests: number;
}

export interface UsageSummary {
  byModel: UsageBreakdown[];
  byProvider: UsageBreakdown[];
  compactionCount: number;
  costComplete: boolean;
  costUsd: number;
  days: UsageDay[];
  from: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  subAgentRuns: number;
  to: string;
  totalTokens: number;
}

export interface TraceMessage {
  role: string;
  seq: number;
  text: string;
  timestamp: number;
}

export interface TraceTool {
  endedAt: number | null;
  error: string | null;
  input: unknown;
  result: string | null;
  startedAt: number;
  status: "completed" | "failed" | "running";
  toolCallId: string;
  toolName: string;
}

export interface TraceApproval {
  approvalId: string;
  decision: "approved" | "denied" | null;
  requestedAt: number;
  resolvedAt: number | null;
  risk: "high" | "normal" | null;
  summary: string;
  toolName: string;
}

export interface TraceRequest {
  estimatedInputTokens: number;
  inputTokens: number;
  messages: unknown[];
  model: string;
  outputTokens: number;
  requestIndex: number;
  seq: number;
  systemPrompt: string;
  /** 与上一份快照相同，正文没有重复记录。 */
  systemPromptUnchanged?: boolean;
  timestamp: number;
  tools: unknown[];
  /** 与上一份快照相同，正文没有重复记录。 */
  toolsUnchanged?: boolean;
}

export interface TraceCompaction {
  afterTokens: number;
  beforeTokens: number;
  checkpointId: string | null;
  seq: number;
  summary: string;
  timestamp: number;
  trigger: "auto" | "manual" | null;
}

export interface TraceSubAgent {
  agentType: string;
  endedAt: number | null;
  errorCode: string | null;
  executionId: string;
  messages: Array<{ role: string; text: string; timestamp: number }>;
  modelId: string;
  name: string;
  parentExecutionId: string | null;
  startedAt: number;
  status: "aborted" | "completed" | "failed" | "queued" | "running";
  task: string;
  tools: TraceTool[];
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface TraceRun {
  approvals: TraceApproval[];
  compactions: TraceCompaction[];
  endedAt: number | null;
  messages: TraceMessage[];
  model: string;
  requests: TraceRequest[];
  runId: string;
  startedAt: number;
  status: "completed" | "failed" | "aborted" | "running";
  steps: number;
  subAgents: TraceSubAgent[];
  tools: TraceTool[];
}

export interface SessionTrace {
  runs: TraceRun[];
  sessionId: string;
}

export interface SkillDetail extends SkillSummary {
  body: string;
  resources: Array<{ path: string; size: number }>;
}

export interface RewriteResult {
  queuedInputId?: string;
  runId?: string;
  session: Session;
}

export interface CheckpointView {
  checkpoint: ContextCheckpoint;
  checkpointId: string;
  coveredFromSeq: number;
  coveredToSeq: number;
  createdAt: number;
  previousCheckpointId: string | null;
  seq: number;
  summary: string;
  trigger: "auto" | "manual";
}

export interface CheckpointDiffEntry {
  added: string[];
  after: string | string[];
  before: string | string[];
  field: keyof ContextCheckpoint;
  removed: string[];
}

export interface CheckpointCompareView {
  base: CheckpointView;
  fields: CheckpointDiffEntry[];
  target: CheckpointView;
}

export interface Workspace {
  createdAt: number;
  displayName: string;
  id: string;
  isAvailable: boolean;
  removedAt: number | null;
  rootPath: string;
  sortOrder: number;
  updatedAt: number;
}

export interface AttachmentView {
  charCount: number;
  createdAt: number;
  fileName: string;
  id: string;
  kind: "docx" | "pdf" | "pptx" | "text" | "xlsx";
  mimeType: string;
}

export interface ChatImage {
  data: string;
  mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
}

export interface GitFileStatus {
  index: string;
  path: string;
  staged: boolean;
  worktree: string;
}

export interface GitStatus {
  branch: string;
  clean: boolean;
  files: GitFileStatus[];
}

export interface FileMergePreviewView {
  base: string | null;
  conflict: boolean;
  merged: string | null;
  ours: string | null;
  path: string;
  theirs: string | null;
}

export interface BackgroundCommandView {
  command: string;
  endedAt: number | null;
  exitCode: number | null;
  id: string;
  name: string;
  sessionId: string;
  startedAt: number;
  status: "exited" | "failed" | "running" | "stopped";
  stderr: string;
  stdout: string;
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
  agentType?: "explorer" | "reviewer" | "worker";
  dependsOn?: string[];
  id: string;
  task: string;
  title?: string;
}

export type TriggerCondition =
  | { type: "always" }
  | { type: "fileMatches"; value: string }
  | { type: "webhookContains"; value: string };

export interface WorkflowRecord {
  createdAt: number;
  fileWatchEnabled: boolean;
  fileWatchPaths: string[];
  id: string;
  lastRunAt: number | null;
  lastRunSessionId: string | null;
  nextRunAt: number | null;
  nodes: WorkflowNodeSpec[];
  scheduleCron: string | null;
  scheduleIntervalMinutes: number | null;
  scheduleTimezone: string | null;
  title: string;
  triggerCondition: TriggerCondition;
  updatedAt: number;
  webhookToken: string | null;
}

export interface WorkflowRunRecord {
  endedAt: number | null;
  id: string;
  runId: string;
  sessionId: string;
  startedAt: number;
  status: "aborted" | "completed" | "failed" | "running";
}

export interface WorkspaceFileView {
  content: string;
  path: string;
  size: number;
}

export interface WorkspaceEntry {
  path: string;
  type: "directory" | "file";
}

export interface MemoryRecord {
  content: string;
  createdAt: number;
  id: string;
  sourceId: string | null;
  title: string;
  updatedAt: number;
}

export interface SessionSearchHit {
  archivedAt: number | null;
  matchedTitle: boolean;
  role: string | null;
  seq: number | null;
  sessionId: string;
  snippet: string;
  title: string;
  updatedAt: number;
  workspaceRoot: string;
}

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
  session: Session;
  subAgents?: SubAgentView[];
  todos: TodoItem[];
  tools?: ToolRunView[];
  userInputs?: UserInputRequestedData[];
}

export type LiteratureStatus = "analyzing" | "done" | "failed" | "ready";

export interface LiteratureSummary {
  charCount: number;
  chunkCount: number | null;
  createdAt: number;
  error: string | null;
  fileName: string;
  hasReport: boolean;
  id: string;
  pageCount: number;
  progress: number | null;
  stage: string | null;
  status: LiteratureStatus;
  title: string;
  updatedAt: number;
}

export interface LiteratureDetail {
  charCount: number;
  chunkCount: number | null;
  createdAt: number;
  error: string | null;
  fileName: string;
  id: string;
  pageCount: number;
  progress: number | null;
  report: LiteratureReport | null;
  stage: string | null;
  status: LiteratureStatus;
  title: string;
  updatedAt: number;
}

export interface SandboxSettings {
  allowedDomains: string[];
  deniedDomains: string[];
  profile: "off" | "read_only" | "workspace_write";
}

export interface HarnessSettings {
  apiKeyConfigured: boolean;
  apiKeySource: "credentials" | "environment" | null;
  approvalMode: "auto_approve" | "full_access" | "request_approval";
  model: string;
  models: ModelChoice[];
  providerId: string;
  providerName: string;
  providers: ProviderChoice[];
  sandbox: SandboxSettings;
  thinkingLevel: string;
}

export interface ModelChoice {
  contextWindow: number;
  id: string;
  maxTokens: number;
  name: string;
  reasoning: boolean;
  thinkingLevels: string[];
}

export interface ModelCatalogProvider {
  configured: boolean;
  id: string;
  models: ModelChoice[];
  name: string;
  oauthSupported: boolean;
}

export interface ModelCatalog {
  default: {
    modelId: string;
    providerId: string;
    thinkingLevel: string;
  };
  providers: ModelCatalogProvider[];
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type CustomProviderProtocol =
  | "anthropic-messages"
  | "openai-completions"
  | "openai-responses";

export interface CustomProviderModel {
  contextWindow: number;
  id: string;
  maxTokens: number;
  name: string;
  reasoning: boolean;
}

export interface CustomProviderView {
  baseUrl: string;
  configured: boolean;
  id: string;
  models: CustomProviderModel[];
  name: string;
  protocol: CustomProviderProtocol;
  requiresApiKey: boolean;
}

export interface SaveCustomProviderInput {
  apiKey?: string;
  baseUrl: string;
  models: CustomProviderModel[];
  name: string;
  protocol: CustomProviderProtocol;
  requiresApiKey: boolean;
}

export interface OAuthProviderView {
  configured: boolean;
  id: string;
  loginLabel: string;
  name: string;
}

export interface OAuthPromptView {
  id: string;
  message: string;
  options?: { description?: string; id: string; label: string }[];
  placeholder?: string;
  type: "manual_code" | "secret" | "select" | "text";
}

export interface OAuthEventView {
  instructions?: string;
  intervalSeconds?: number;
  links?: { label?: string; url: string }[];
  message?: string;
  type: "auth_url" | "device_code" | "info" | "progress";
  url?: string;
  userCode?: string;
  verificationUri?: string;
}

export interface OAuthLoginView {
  error: string | null;
  events: OAuthEventView[];
  id: string;
  prompt: OAuthPromptView | null;
  providerId: string;
  status: "cancelled" | "error" | "pending" | "success";
}

export interface ProviderChoice {
  id: string;
  modelCount: number;
  name: string;
}

export interface SaveModelSettingsInput {
  apiKey?: string;
  clearApiKey?: boolean;
  modelId: string;
  providerId: string;
  thinkingLevel?: string;
}

export interface LiteratureText {
  pageCount: number;
  pages: string[];
}

export interface BoardTaskWorkspace {
  name: string;
  root: string;
}

export type { BoardTaskView };

export interface KnowledgeHit {
  chunkId: string;
  content: string;
  documentId: string;
  documentTitle: string;
  kind: "literature" | "memory" | "workspace";
  pageEnd: number;
  pageStart: number;
  section: string | null;
  sourceId: string | null;
}

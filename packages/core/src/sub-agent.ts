import type { SubAgentStatus, Usage } from "./events";
import type { AgentMessage } from "./messages";

export interface SubAgentToolView {
  error?: string | undefined;
  input: unknown;
  result?: string | undefined;
  status: "completed" | "failed" | "running";
  toolCallId: string;
  toolName: string;
}

export interface SubAgentView {
  agentType: string;
  dependsOn: string[];
  errorCode: string | null;
  executionId: string;
  messages: AgentMessage[];
  name: string;
  parentExecutionId: string | null;
  resultSummary: string | null;
  status: SubAgentStatus;
  task: string;
  tools: SubAgentToolView[];
  usage?: Usage | undefined;
}

export const BoardTaskStatus = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  WAITING: "waiting",
  CONFIRMATION: "confirmation",
  COMPLETED: "completed",
} as const;

export type BoardTaskStatus = (typeof BoardTaskStatus)[keyof typeof BoardTaskStatus];

export interface BoardTaskProgress {
  completed: number;
  total: number;
}

export interface BoardTaskView {
  attentionReason: string | null;
  completedAt: number | null;
  createdAt: number;
  currentStep: string | null;
  fileChangeCount: number;
  id: string;
  objective: string;
  progress: BoardTaskProgress | null;
  rootRunId: string | null;
  sessionId: string | null;
  status: BoardTaskStatus;
  title: string;
  updatedAt: number;
  workspaceName: string;
  workspaceRoot: string;
}

import { queryOptions } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  BackgroundCommandView,
  BoardTaskView,
  BoardTaskWorkspace,
  CheckpointCompareView,
  CheckpointView,
  CustomProviderView,
  FileMergePreviewView,
  GitStatus,
  HarnessSettings,
  KnowledgeHit,
  LiteratureDetail,
  LiteratureSummary,
  LiteratureText,
  MemoryRecord,
  ModelCatalog,
  OAuthProviderView,
  Session,
  SessionCompareView,
  SessionSearchHit,
  SessionSnapshot,
  SessionTrace,
  SkillDetail,
  SkillSummary,
  UsageSummary,
  WorkflowRecord,
  WorkflowRunRecord,
  Workspace,
  WorkspaceEntry,
  WorkspaceFileView,
} from "./types";

export const queryKeys = {
  backgroundCommands: (sessionId: string) =>
    ["sessions", sessionId, "background-commands"] as const,
  gitStatus: (sessionId: string) => ["sessions", sessionId, "git", "status"] as const,
  gitDiff: (sessionId: string, path: string, staged: boolean) =>
    ["sessions", sessionId, "git", "diff", path, staged] as const,
  boardTasks: ["board", "tasks"] as const,
  boardWorkspaces: ["board", "workspaces"] as const,
  commandPrefixes: ["settings", "command-prefixes"] as const,
  customProviders: ["providers", "custom"] as const,
  oauthProviders: ["providers", "oauth"] as const,
  literature: (id?: string) => ["literature", ...(id === undefined ? [] : [id])] as const,
  knowledgeSearch: (query: string) => ["knowledge", "search", query] as const,
  literatureText: (id: string) => ["literature", id, "text"] as const,
  memories: ["memories"] as const,
  memorySearch: (query: string) => ["memories", "search", query] as const,
  modelCatalog: ["models", "catalog"] as const,
  session: (id: string) => ["session", id] as const,
  sessionSkills: (id: string) => ["sessions", id, "skills"] as const,
  trace: (id: string) => ["sessions", id, "trace"] as const,
  usage: (filters: string) => ["usage", filters] as const,
  skills: (workspaceId?: string) => ["skills", workspaceId ?? "all"] as const,
  checkpoints: (id: string) => ["sessions", id, "checkpoints"] as const,
  checkpointCompare: (id: string, base: string, target: string) =>
    ["sessions", id, "checkpoints", "compare", base, target] as const,
  sessionCompare: (base: string, target: string) => ["sessions", "compare", base, target] as const,
  mergePreview: (source: string, target: string) =>
    ["sessions", "merge-preview", source, target] as const,
  sessionFiles: (id: string, path: string) => ["sessions", id, "files", path] as const,
  workspaceFile: (id: string, path: string) => ["sessions", id, "file", path] as const,
  sessionSearch: (query: string) => ["sessions", "search", query] as const,
  sessions: ["sessions"] as const,
  workspaces: ["workspaces"] as const,
  archivedSessions: ["sessions", "archived"] as const,
  settings: ["settings"] as const,
  workflows: ["workflows"] as const,
  workflowRuns: (id: string) => ["workflows", id, "runs"] as const,
};

export function boardTasksQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<BoardTaskView[]>("/api/board/tasks"),
    queryKey: queryKeys.boardTasks,
    refetchInterval: 3_000,
  });
}

export function boardWorkspacesQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<BoardTaskWorkspace[]>("/api/board/workspaces"),
    queryKey: queryKeys.boardWorkspaces,
    staleTime: 30_000,
  });
}

export function memoriesQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<MemoryRecord[]>("/api/memories"),
    queryKey: queryKeys.memories,
  });
}

export function memorySearchQueryOptions(query: string) {
  const trimmed = query.trim();
  return queryOptions({
    enabled: trimmed !== "",
    queryFn: () =>
      apiFetch<KnowledgeHit[]>(`/api/memories/search?q=${encodeURIComponent(trimmed)}&limit=20`),
    queryKey: queryKeys.memorySearch(trimmed),
    staleTime: 5_000,
  });
}

export function workflowsQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<WorkflowRecord[]>("/api/workflows"),
    queryKey: queryKeys.workflows,
  });
}

export function workflowRunsQueryOptions(workflowId: string) {
  return queryOptions({
    queryFn: () =>
      apiFetch<WorkflowRunRecord[]>(`/api/workflows/${encodeURIComponent(workflowId)}/runs`),
    queryKey: queryKeys.workflowRuns(workflowId),
    refetchInterval: 5_000,
  });
}

export function sessionCompareQueryOptions(base: string, target: string) {
  return queryOptions({
    enabled: base !== "" && target !== "" && base !== target,
    queryFn: () =>
      apiFetch<SessionCompareView>(
        `/api/sessions/compare?base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}`,
      ),
    queryKey: queryKeys.sessionCompare(base, target),
    staleTime: 5_000,
  });
}

export function mergePreviewQueryOptions(source: string, target: string) {
  return queryOptions({
    enabled: source !== "" && target !== "" && source !== target,
    queryFn: () =>
      apiFetch<FileMergePreviewView[]>(
        `/api/sessions/merge-preview?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`,
      ),
    queryKey: queryKeys.mergePreview(source, target),
    staleTime: 5_000,
  });
}

export function sessionsQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<Session[]>("/api/sessions"),
    queryKey: queryKeys.sessions,
    refetchInterval: 10_000,
  });
}

export function workspacesQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<Workspace[]>("/api/workspaces?includeRemoved=1"),
    queryKey: queryKeys.workspaces,
    staleTime: 10_000,
  });
}

export function modelCatalogQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<ModelCatalog>("/api/models"),
    queryKey: queryKeys.modelCatalog,
    staleTime: 30_000,
  });
}

export function commandPrefixesQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<string[]>("/api/settings/command-prefixes"),
    queryKey: queryKeys.commandPrefixes,
  });
}

export function customProvidersQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<CustomProviderView[]>("/api/providers/custom"),
    queryKey: queryKeys.customProviders,
    staleTime: 10_000,
  });
}

export function oauthProvidersQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<OAuthProviderView[]>("/api/providers/oauth"),
    queryKey: queryKeys.oauthProviders,
    staleTime: 10_000,
  });
}

export function archivedSessionsQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<Session[]>("/api/sessions?includeArchived=1"),
    queryKey: queryKeys.archivedSessions,
  });
}

export function sessionSearchQueryOptions(query: string) {
  const trimmed = query.trim();
  return queryOptions({
    enabled: trimmed !== "",
    queryFn: () =>
      apiFetch<SessionSearchHit[]>(
        `/api/sessions/search?q=${encodeURIComponent(trimmed)}&limit=20`,
      ),
    queryKey: queryKeys.sessionSearch(trimmed),
    staleTime: 5_000,
  });
}

export function gitStatusQueryOptions(sessionId: string) {
  return queryOptions({
    queryFn: () => apiFetch<GitStatus>(`/api/sessions/${encodeURIComponent(sessionId)}/git/status`),
    queryKey: queryKeys.gitStatus(sessionId),
    refetchInterval: 3_000,
  });
}

export function gitDiffQueryOptions(sessionId: string, path: string, staged: boolean) {
  return queryOptions({
    enabled: path !== "",
    queryFn: async () => {
      const result = await apiFetch<{ diff: string }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/git/diff?path=${encodeURIComponent(path)}${staged ? "&staged=1" : ""}`,
      );
      return result.diff;
    },
    queryKey: queryKeys.gitDiff(sessionId, path, staged),
    staleTime: 2_000,
  });
}

export function backgroundCommandsQueryOptions(sessionId: string) {
  return queryOptions({
    queryFn: () =>
      apiFetch<BackgroundCommandView[]>(
        `/api/sessions/${encodeURIComponent(sessionId)}/background-commands`,
      ),
    queryKey: queryKeys.backgroundCommands(sessionId),
    refetchInterval: 2_000,
  });
}

export function sessionFilesQueryOptions(sessionId: string, path = ".") {
  return queryOptions({
    queryFn: () =>
      apiFetch<{ entries: WorkspaceEntry[]; truncated: boolean }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(path)}&depth=4`,
      ),
    queryKey: queryKeys.sessionFiles(sessionId, path),
    staleTime: 10_000,
  });
}

export function workspaceFileQueryOptions(sessionId: string, path: string) {
  return queryOptions({
    enabled: path !== "",
    queryFn: () =>
      apiFetch<WorkspaceFileView>(
        `/api/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(path)}`,
      ),
    queryKey: queryKeys.workspaceFile(sessionId, path),
    staleTime: 5_000,
  });
}

export function sessionSnapshotQueryOptions(sessionId: string) {
  return queryOptions({
    queryFn: () => apiFetch<SessionSnapshot>(`/api/sessions/${encodeURIComponent(sessionId)}`),
    queryKey: queryKeys.session(sessionId),
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
}

export function checkpointsQueryOptions(sessionId: string) {
  return queryOptions({
    queryFn: async () => {
      const result = await apiFetch<{ checkpoints: CheckpointView[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
      );
      return result.checkpoints;
    },
    queryKey: queryKeys.checkpoints(sessionId),
    staleTime: 0,
  });
}

export function sessionSkillsQueryOptions(sessionId: string) {
  return queryOptions({
    queryFn: async () => {
      const result = await apiFetch<{ skills: SkillSummary[] }>(
        `/api/sessions/${encodeURIComponent(sessionId)}/skills`,
      );
      return result.skills;
    },
    queryKey: queryKeys.sessionSkills(sessionId),
    staleTime: 10_000,
  });
}

export function skillsQueryOptions(workspaceId?: string) {
  return queryOptions({
    queryFn: async () => {
      const query =
        workspaceId === undefined ? "" : `?workspaceId=${encodeURIComponent(workspaceId)}`;
      const result = await apiFetch<{ skills: SkillSummary[] }>(`/api/skills${query}`);
      return result.skills;
    },
    queryKey: queryKeys.skills(workspaceId),
    staleTime: 10_000,
  });
}

export function usageQueryOptions(input: {
  from?: string | undefined;
  modelId?: string | undefined;
  providerId?: string | undefined;
  to?: string | undefined;
}) {
  const params = new URLSearchParams();
  if (input.from !== undefined) params.set("from", input.from);
  if (input.to !== undefined) params.set("to", input.to);
  if (input.providerId !== undefined) params.set("providerId", input.providerId);
  if (input.modelId !== undefined) params.set("modelId", input.modelId);
  const query = params.toString();
  return queryOptions({
    queryFn: () => apiFetch<UsageSummary>(`/api/usage${query === "" ? "" : `?${query}`}`),
    queryKey: queryKeys.usage(query),
    staleTime: 30_000,
  });
}

export function traceQueryOptions(sessionId: string) {
  return queryOptions({
    queryFn: () => apiFetch<SessionTrace>(`/api/sessions/${encodeURIComponent(sessionId)}/trace`),
    queryKey: queryKeys.trace(sessionId),
    staleTime: 10_000,
  });
}

export function skillDetailQueryOptions(
  scope: SkillSummary["scope"],
  id: string,
  workspaceId?: string,
) {
  return queryOptions({
    queryFn: () => {
      const query =
        workspaceId === undefined ? "" : `?workspaceId=${encodeURIComponent(workspaceId)}`;
      return apiFetch<SkillDetail>(
        `/api/skills/${encodeURIComponent(scope)}/${encodeURIComponent(id)}${query}`,
      );
    },
    queryKey: [...queryKeys.skills(workspaceId), "detail", scope, id] as const,
    staleTime: 30_000,
  });
}

export function checkpointCompareQueryOptions(sessionId: string, base: string, target: string) {
  return queryOptions({
    enabled: base !== "" && target !== "" && base !== target,
    queryFn: () =>
      apiFetch<CheckpointCompareView>(
        `/api/sessions/${encodeURIComponent(sessionId)}/checkpoints/compare?base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}`,
      ),
    queryKey: queryKeys.checkpointCompare(sessionId, base, target),
    staleTime: 5_000,
  });
}

export function settingsQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<HarnessSettings>("/api/settings"),
    queryKey: queryKeys.settings,
  });
}

export function literatureListQueryOptions() {
  return queryOptions({
    queryFn: () => apiFetch<LiteratureSummary[]>("/api/literature"),
    queryKey: queryKeys.literature(),
    refetchInterval: 8_000,
  });
}

export function literatureDetailQueryOptions(id: string) {
  return queryOptions({
    queryFn: () => apiFetch<LiteratureDetail>(`/api/literature/${encodeURIComponent(id)}`),
    queryKey: queryKeys.literature(id),
    refetchInterval: (query) => (query.state.data?.status === "analyzing" ? 1_500 : false),
  });
}

export function knowledgeSearchQueryOptions(query: string) {
  return queryOptions({
    enabled: query.trim().length > 0,
    queryFn: () =>
      apiFetch<KnowledgeHit[]>(
        `/api/knowledge/search?q=${encodeURIComponent(query.trim())}&limit=10`,
      ),
    queryKey: queryKeys.knowledgeSearch(query.trim()),
    staleTime: 10_000,
  });
}

export function literatureTextQueryOptions(id: string, enabled: boolean) {
  return queryOptions({
    queryFn: () => apiFetch<LiteratureText>(`/api/literature/${encodeURIComponent(id)}/text`),
    queryKey: queryKeys.literatureText(id),
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

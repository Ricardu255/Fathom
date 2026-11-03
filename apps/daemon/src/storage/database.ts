import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BoardTaskStatus, KnowledgeDocumentKind, KnowledgeHit } from "@harness/core";
import { normalizeSandboxSettings, type SandboxSettings } from "@harness/sandbox";

export interface SessionRecord {
  archivedAt: number | null;
  createdAt: number;
  id: string;
  lastSeq: number;
  modelId: string | null;
  parentSessionId: string | null;
  piSessionFile: string | null;
  providerId: string | null;
  thinkingLevel: string | null;
  title: string;
  updatedAt: number;
  workspaceId: string | null;
  workspaceRoot: string;
}

export interface WorkspaceRecord {
  createdAt: number;
  displayName: string;
  id: string;
  removedAt: number | null;
  rootPath: string;
  sortOrder: number;
  updatedAt: number;
}

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

export interface CustomProviderRecord {
  baseUrl: string;
  createdAt: number;
  id: string;
  models: CustomProviderModel[];
  name: string;
  protocol: CustomProviderProtocol;
  requiresApiKey: boolean;
  updatedAt: number;
}

export interface MemoryRecord {
  content: string;
  createdAt: number;
  id: string;
  sourceId: string | null;
  title: string;
  updatedAt: number;
}

export interface WorkflowRecord {
  createdAt: number;
  fileWatchEnabled: boolean;
  fileWatchPaths: string[];
  id: string;
  lastRunAt: number | null;
  lastRunSessionId: string | null;
  nextRunAt: number | null;
  nodesJson: string;
  scheduleCron: string | null;
  scheduleIntervalMinutes: number | null;
  scheduleTimezone: string | null;
  title: string;
  triggerConditionJson: string | null;
  updatedAt: number;
  webhookToken: string | null;
}

export interface ChatAttachmentRecord {
  charCount: number;
  createdAt: number;
  fileName: string;
  id: string;
  kind: "docx" | "pdf" | "pptx" | "text" | "xlsx";
  mimeType: string;
  sessionId: string;
  textContent: string;
}

export interface WorkflowRunRecord {
  id: string;
  runId: string;
  sessionId: string;
  startedAt: number;
  workflowId: string;
}

export interface BoardTaskRecord {
  archivedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  id: string;
  objective: string;
  position: number;
  rootRunId: string | null;
  sessionId: string | null;
  status: BoardTaskStatus;
  title: string;
  updatedAt: number;
  workspaceRoot: string;
}

export type LiteratureStatus = "analyzing" | "done" | "failed" | "ready";

export interface LiteratureRecord {
  charCount: number;
  chunkCount: number | null;
  createdAt: number;
  error: string | null;
  fileName: string;
  id: string;
  pageCount: number;
  progress: number | null;
  reportJson: string | null;
  stage: string | null;
  status: LiteratureStatus;
  title: string;
  updatedAt: number;
}

export type ApprovalMode = "auto_approve" | "full_access" | "request_approval";

export interface SessionMessageHit {
  content: string;
  role: string;
  seq: number;
  sessionId: string;
  timestamp: number;
}

export interface HarnessSettings {
  approvalMode: ApprovalMode;
  sandbox: SandboxSettings;
}

type Row = Record<string, string | number | bigint | null | Uint8Array>;

const MIGRATIONS: readonly { sql: string; version: number }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_meta (
        version INTEGER PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions (archived_at, updated_at DESC);

      CREATE TABLE IF NOT EXISTS literature (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        page_count INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
        char_count INTEGER NOT NULL DEFAULT 0 CHECK (char_count >= 0),
        status TEXT NOT NULL CHECK (status IN ('ready', 'analyzing', 'done', 'failed')),
        report_json TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS literature_updated_at_idx ON literature (updated_at DESC);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE sessions ADD COLUMN pi_session_file TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE literature ADD COLUMN stage TEXT;
      ALTER TABLE literature ADD COLUMN progress REAL;
      ALTER TABLE literature ADD COLUMN chunk_count INTEGER;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('literature', 'workspace', 'memory')),
        source_id TEXT,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS knowledge_documents_kind_idx
        ON knowledge_documents (kind, updated_at DESC);

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        page_start INTEGER NOT NULL CHECK (page_start >= 0),
        page_end INTEGER NOT NULL CHECK (page_end >= 0),
        section TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx
        ON knowledge_chunks (document_id, ordinal);

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        content,
        chunk_id UNINDEXED,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS knowledge_embeddings (
        chunk_id TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK (dimensions > 0),
        vector BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS board_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        session_id TEXT,
        root_run_id TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'in_progress', 'waiting', 'confirmation', 'completed')
        ),
        position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        archived_at INTEGER
      ) STRICT;

      CREATE INDEX IF NOT EXISTS board_tasks_status_position_idx
        ON board_tasks (archived_at, status, position);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE sessions ADD COLUMN parent_session_id TEXT;
      CREATE INDEX IF NOT EXISTS sessions_parent_idx ON sessions (parent_session_id);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        nodes_json TEXT NOT NULL,
        last_run_session_id TEXT,
        last_run_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS workflows_updated_idx ON workflows (updated_at DESC);
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE workflows ADD COLUMN schedule_interval_minutes INTEGER;
      ALTER TABLE workflows ADD COLUMN next_run_at INTEGER;

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        started_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS workflow_runs_workflow_idx
        ON workflow_runs (workflow_id, started_at DESC);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS chat_attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('pdf', 'docx', 'xlsx', 'text')),
        char_count INTEGER NOT NULL CHECK (char_count >= 0),
        text_content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS chat_attachments_session_idx
        ON chat_attachments (session_id, created_at DESC);
    `,
  },
  {
    version: 10,
    sql: `
      ALTER TABLE workflows ADD COLUMN webhook_token TEXT;
      ALTER TABLE workflows ADD COLUMN file_watch_paths_json TEXT;
      ALTER TABLE workflows ADD COLUMN file_watch_enabled INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 11,
    sql: `
      DROP INDEX IF EXISTS chat_attachments_session_idx;
      ALTER TABLE chat_attachments RENAME TO chat_attachments_old;

      CREATE TABLE chat_attachments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        file_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('pdf', 'docx', 'pptx', 'xlsx', 'text')),
        char_count INTEGER NOT NULL CHECK (char_count >= 0),
        text_content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      INSERT INTO chat_attachments
        (id, session_id, file_name, mime_type, kind, char_count, text_content, created_at)
      SELECT id, session_id, file_name, mime_type, kind, char_count, text_content, created_at
      FROM chat_attachments_old;

      DROP TABLE chat_attachments_old;
      CREATE INDEX chat_attachments_session_idx
        ON chat_attachments (session_id, created_at DESC);
    `,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE workflows ADD COLUMN schedule_cron TEXT;
      ALTER TABLE workflows ADD COLUMN schedule_timezone TEXT;
      ALTER TABLE workflows ADD COLUMN trigger_condition_json TEXT;
    `,
  },
  {
    version: 13,
    sql: `
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
        removed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS workspaces_order_idx
        ON workspaces (removed_at, sort_order, created_at);

      ALTER TABLE sessions ADD COLUMN workspace_id TEXT;
      CREATE INDEX IF NOT EXISTS sessions_workspace_idx
        ON sessions (workspace_id, archived_at, updated_at DESC);
    `,
  },
  {
    version: 14,
    sql: `
      ALTER TABLE sessions ADD COLUMN provider_id TEXT;
      ALTER TABLE sessions ADD COLUMN model_id TEXT;
      ALTER TABLE sessions ADD COLUMN thinking_level TEXT;
    `,
  },
  {
    version: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS custom_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL CHECK (
          protocol IN ('openai-completions', 'openai-responses', 'anthropic-messages')
        ),
        base_url TEXT NOT NULL,
        requires_api_key INTEGER NOT NULL DEFAULT 1 CHECK (requires_api_key IN (0, 1)),
        models_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 16,
    sql: `
      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
        content,
        session_id UNINDEXED,
        seq UNINDEXED,
        role UNINDEXED,
        timestamp UNINDEXED,
        tokenize='trigram'
      );
    `,
  },
];

export class HarnessDatabase {
  private readonly database: DatabaseSync;

  public constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.applyMigrations();
    this.backfillWorkspaces();
  }

  public close(): void {
    this.database.close();
  }

  // Session
  public listSessions(includeArchived = false): SessionRecord[] {
    const rows = includeArchived
      ? this.database.prepare("SELECT * FROM sessions ORDER BY updated_at DESC").all()
      : this.database
          .prepare("SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY updated_at DESC")
          .all();
    return rows.map(mapSession);
  }

  public indexSessionMessage(input: {
    content: string;
    role: string;
    seq: number;
    sessionId: string;
    timestamp: number;
  }): void {
    this.database
      .prepare("DELETE FROM session_messages_fts WHERE session_id = ? AND seq = ?")
      .run(input.sessionId, input.seq);
    this.database
      .prepare(
        `INSERT INTO session_messages_fts (content, session_id, seq, role, timestamp)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.content, input.sessionId, input.seq, input.role, input.timestamp);
  }

  public clearSessionMessages(sessionId: string): void {
    this.database.prepare("DELETE FROM session_messages_fts WHERE session_id = ?").run(sessionId);
  }

  public sessionMessageCount(): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM session_messages_fts").get();
    return row === undefined ? 0 : readNumber(row, "count");
  }

  public searchSessionMessages(query: string, limit = 30): SessionMessageHit[] {
    const normalized = query.trim();
    if (normalized === "") return [];
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const shortQuery = [...normalized].length < 3;
    const rows = shortQuery
      ? this.database
          .prepare(
            `SELECT f.content, f.role, f.seq, f.session_id, f.timestamp
             FROM session_messages_fts f
             JOIN sessions s ON s.id = f.session_id
             WHERE s.archived_at IS NULL AND f.content LIKE ? ESCAPE '\\'
             ORDER BY f.timestamp DESC LIMIT ?`,
          )
          .all(`%${escapeLike(normalized)}%`, safeLimit)
      : this.database
          .prepare(
            `SELECT session_messages_fts.content, session_messages_fts.role,
                    session_messages_fts.seq, session_messages_fts.session_id,
                    session_messages_fts.timestamp
             FROM session_messages_fts
             JOIN sessions s ON s.id = session_messages_fts.session_id
             WHERE s.archived_at IS NULL AND session_messages_fts MATCH ?
             ORDER BY session_messages_fts.timestamp DESC LIMIT ?`,
          )
          .all(`"${normalized.replaceAll('"', '""')}"`, safeLimit);
    return rows.map((row) => ({
      content: readString(row, "content"),
      role: readString(row, "role"),
      seq: readNumber(row, "seq"),
      sessionId: readString(row, "session_id"),
      timestamp: readNumber(row, "timestamp"),
    }));
  }

  public getSession(id: string): SessionRecord | null {
    const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row === undefined ? null : mapSession(row);
  }

  public createSession(input: {
    id?: string;
    modelId?: string | null;
    parentSessionId?: string | null;
    piSessionFile?: string | null;
    providerId?: string | null;
    thinkingLevel?: string | null;
    title: string;
    workspaceId?: string | null;
    workspaceRoot: string;
  }): SessionRecord {
    const id = input.id ?? randomUUID();
    const now = Date.now();
    const piSessionFile = input.piSessionFile ?? null;
    const workspaceId = input.workspaceId ?? this.ensureWorkspaceForRoot(input.workspaceRoot).id;
    this.database
      .prepare(
        `INSERT INTO sessions
         (id, title, workspace_root, workspace_id, provider_id, model_id, thinking_level,
          parent_session_id, pi_session_file, last_seq, created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
      )
      .run(
        id,
        input.title,
        input.workspaceRoot,
        workspaceId,
        input.providerId ?? null,
        input.modelId ?? null,
        input.thinkingLevel ?? null,
        input.parentSessionId ?? null,
        piSessionFile,
        now,
        now,
      );
    return {
      archivedAt: null,
      createdAt: now,
      id,
      lastSeq: 0,
      modelId: input.modelId ?? null,
      parentSessionId: input.parentSessionId ?? null,
      piSessionFile,
      providerId: input.providerId ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      title: input.title,
      updatedAt: now,
      workspaceId,
      workspaceRoot: input.workspaceRoot,
    };
  }

  public updateSessionModel(
    id: string,
    providerId: string,
    modelId: string,
    thinkingLevel: string,
  ): SessionRecord | null {
    this.database
      .prepare(
        `UPDATE sessions
         SET provider_id = ?, model_id = ?, thinking_level = ?, updated_at = ?
         WHERE id = ? AND archived_at IS NULL`,
      )
      .run(providerId, modelId, thinkingLevel, Date.now(), id);
    return this.getSession(id);
  }

  public setSessionPiFile(id: string, path: string): void {
    this.database
      .prepare("UPDATE sessions SET pi_session_file = ?, updated_at = ? WHERE id = ?")
      .run(path, Date.now(), id);
  }

  public updateSessionTitle(id: string, title: string): void {
    this.database
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
      .run(title, Date.now(), id);
  }

  public touchSession(id: string, at: number): void {
    this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(at, id);
  }

  public setSessionLastSeq(id: string, seq: number): void {
    this.database
      .prepare("UPDATE sessions SET last_seq = MAX(last_seq, ?) WHERE id = ?")
      .run(seq, id);
  }

  public archiveSession(id: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL",
        )
        .run(Date.now(), Date.now(), id).changes > 0
    );
  }

  public restoreSession(id: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE sessions SET archived_at = NULL, updated_at = ? WHERE id = ? AND archived_at IS NOT NULL",
        )
        .run(Date.now(), id).changes > 0
    );
  }

  // Literature
  public listLiterature(): LiteratureRecord[] {
    return this.database
      .prepare("SELECT * FROM literature ORDER BY updated_at DESC")
      .all()
      .map(mapLiterature);
  }

  public getLiterature(id: string): LiteratureRecord | null {
    const row = this.database.prepare("SELECT * FROM literature WHERE id = ?").get(id);
    return row === undefined ? null : mapLiterature(row);
  }

  public createLiterature(input: {
    charCount: number;
    fileName: string;
    id: string;
    pageCount: number;
    title: string;
  }): LiteratureRecord {
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO literature
         (id, title, file_name, page_count, char_count, status, stage, progress, chunk_count,
          report_json, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'ready', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      )
      .run(input.id, input.title, input.fileName, input.pageCount, input.charCount, now, now);
    const record = this.getLiterature(input.id);
    if (record === null) throw new Error("文献记录创建失败");
    return record;
  }

  public updateLiterature(
    id: string,
    patch: {
      chunkCount?: number | null;
      error?: string | null;
      progress?: number | null;
      reportJson?: string | null;
      stage?: string | null;
      status?: LiteratureStatus;
      title?: string;
    },
  ): void {
    const current = this.getLiterature(id);
    if (current === null) throw new Error("文献不存在");
    const next = {
      chunkCount: patch.chunkCount === undefined ? current.chunkCount : patch.chunkCount,
      error: patch.error === undefined ? current.error : patch.error,
      progress: patch.progress === undefined ? current.progress : patch.progress,
      reportJson: patch.reportJson === undefined ? current.reportJson : patch.reportJson,
      stage: patch.stage === undefined ? current.stage : patch.stage,
      status: patch.status ?? current.status,
      title: patch.title ?? current.title,
    };
    this.database
      .prepare(
        `UPDATE literature
         SET title = ?, status = ?, stage = ?, progress = ?, chunk_count = ?,
             report_json = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.title,
        next.status,
        next.stage,
        next.progress,
        next.chunkCount,
        next.reportJson,
        next.error,
        Date.now(),
        id,
      );
  }

  public deleteLiterature(id: string): boolean {
    return this.database.prepare("DELETE FROM literature WHERE id = ?").run(id).changes > 0;
  }

  // Board tasks
  public listBoardTasks(includeArchived = false): BoardTaskRecord[] {
    const rows = includeArchived
      ? this.database
          .prepare("SELECT * FROM board_tasks ORDER BY status, position, updated_at DESC")
          .all()
      : this.database
          .prepare(
            "SELECT * FROM board_tasks WHERE archived_at IS NULL ORDER BY status, position, updated_at DESC",
          )
          .all();
    return rows.map(mapBoardTask);
  }

  public getBoardTask(id: string): BoardTaskRecord | null {
    const row = this.database.prepare("SELECT * FROM board_tasks WHERE id = ?").get(id);
    return row === undefined ? null : mapBoardTask(row);
  }

  public createBoardTask(input: {
    id: string;
    objective: string;
    title: string;
    workspaceRoot: string;
  }): BoardTaskRecord {
    const now = Date.now();
    const max = this.database
      .prepare("SELECT MAX(position) AS position FROM board_tasks WHERE archived_at IS NULL")
      .get();
    const position = (max === undefined ? 0 : readNumber(max, "position", 0)) + 1;
    this.database
      .prepare(
        `INSERT INTO board_tasks
         (id, title, objective, workspace_root, session_id, root_run_id, status, position,
          created_at, updated_at, completed_at, archived_at)
         VALUES (?, ?, ?, ?, NULL, NULL, 'pending', ?, ?, ?, NULL, NULL)`,
      )
      .run(input.id, input.title, input.objective, input.workspaceRoot, position, now, now);
    const record = this.getBoardTask(input.id);
    if (record === null) throw new Error("任务创建失败");
    return record;
  }

  public updateBoardTask(
    id: string,
    patch: {
      completedAt?: number | null;
      objective?: string;
      rootRunId?: string | null;
      sessionId?: string | null;
      status?: BoardTaskStatus;
      title?: string;
    },
  ): boolean {
    const current = this.getBoardTask(id);
    if (current === null) return false;
    return (
      this.database
        .prepare(
          `UPDATE board_tasks SET
             title = ?, objective = ?, session_id = ?, root_run_id = ?, status = ?,
             completed_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          patch.title ?? current.title,
          patch.objective ?? current.objective,
          patch.sessionId === undefined ? current.sessionId : patch.sessionId,
          patch.rootRunId === undefined ? current.rootRunId : patch.rootRunId,
          patch.status ?? current.status,
          patch.completedAt === undefined ? current.completedAt : patch.completedAt,
          Date.now(),
          id,
        ).changes > 0
    );
  }

  public archiveBoardTask(id: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE board_tasks SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL",
        )
        .run(Date.now(), Date.now(), id).changes > 0
    );
  }

  // Knowledge / RAG
  public indexKnowledgeDocument(
    document: {
      id: string;
      kind: KnowledgeDocumentKind;
      sourceId: string | null;
      title: string;
    },
    chunks: readonly {
      content: string;
      id: string;
      ordinal: number;
      pageEnd: number;
      pageStart: number;
      section: string | null;
    }[],
  ): void {
    const now = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `INSERT INTO knowledge_documents (id, kind, source_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             source_id = excluded.source_id,
             updated_at = excluded.updated_at`,
        )
        .run(document.id, document.kind, document.sourceId, document.title, now, now);
      this.database
        .prepare(
          `DELETE FROM knowledge_chunks_fts
           WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id = ?)`,
        )
        .run(document.id);
      this.database.prepare("DELETE FROM knowledge_chunks WHERE document_id = ?").run(document.id);
      const insertChunk = this.database.prepare(
        `INSERT INTO knowledge_chunks
           (id, document_id, ordinal, page_start, page_end, section, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.database.prepare(
        "INSERT INTO knowledge_chunks_fts (content, chunk_id) VALUES (?, ?)",
      );
      for (const chunk of chunks) {
        insertChunk.run(
          chunk.id,
          document.id,
          chunk.ordinal,
          chunk.pageStart,
          chunk.pageEnd,
          chunk.section,
          chunk.content,
          now,
        );
        insertFts.run(chunk.content, chunk.id);
      }
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public updateKnowledgeDocumentTitle(id: string, title: string): void {
    this.database
      .prepare("UPDATE knowledge_documents SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, Date.now(), id);
  }

  public hasKnowledgeDocument(id: string): boolean {
    return (
      this.database.prepare("SELECT 1 FROM knowledge_documents WHERE id = ?").get(id) !== undefined
    );
  }

  public deleteKnowledgeDocument(id: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database
        .prepare(
          `DELETE FROM knowledge_chunks_fts
           WHERE chunk_id IN (SELECT id FROM knowledge_chunks WHERE document_id = ?)`,
        )
        .run(id);
      this.database.prepare("DELETE FROM knowledge_documents WHERE id = ?").run(id);
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public searchKnowledge(
    query: string,
    limit = 8,
    kinds?: readonly KnowledgeDocumentKind[],
  ): KnowledgeHit[] {
    const normalized = query.trim();
    if (normalized === "") return [];
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const kindFilter =
      kinds === undefined || kinds.length === 0
        ? ""
        : ` AND documents.kind IN (${kinds.map(() => "?").join(", ")})`;
    const kindParams = kinds === undefined ? [] : [...kinds];

    if ([...normalized].length < 3) {
      return this.database
        .prepare(
          `SELECT chunks.*, documents.title AS document_title, documents.kind, documents.source_id
           FROM knowledge_chunks chunks
           JOIN knowledge_documents documents ON documents.id = chunks.document_id
           WHERE chunks.content LIKE ? ESCAPE '\\'${kindFilter}
           ORDER BY documents.updated_at DESC, chunks.ordinal
           LIMIT ?`,
        )
        .all(`%${escapeLike(normalized)}%`, ...kindParams, safeLimit)
        .map(mapKnowledgeHit);
    }

    try {
      const expression = `"${normalized.replaceAll('"', '""')}"`;
      return this.database
        .prepare(
          `SELECT chunks.*, documents.title AS document_title, documents.kind, documents.source_id,
                  bm25(knowledge_chunks_fts) AS score
           FROM knowledge_chunks_fts
           JOIN knowledge_chunks chunks ON chunks.id = knowledge_chunks_fts.chunk_id
           JOIN knowledge_documents documents ON documents.id = chunks.document_id
           WHERE knowledge_chunks_fts MATCH ?${kindFilter}
           ORDER BY score
           LIMIT ?`,
        )
        .all(expression, ...kindParams, safeLimit)
        .map(mapKnowledgeHit);
    } catch {
      return this.database
        .prepare(
          `SELECT chunks.*, documents.title AS document_title, documents.kind, documents.source_id
           FROM knowledge_chunks chunks
           JOIN knowledge_documents documents ON documents.id = chunks.document_id
           WHERE chunks.content LIKE ? ESCAPE '\\'${kindFilter}
           ORDER BY documents.updated_at DESC, chunks.ordinal
           LIMIT ?`,
        )
        .all(`%${escapeLike(normalized)}%`, ...kindParams, safeLimit)
        .map(mapKnowledgeHit);
    }
  }

  public listMemories(): MemoryRecord[] {
    return this.database
      .prepare(
        `SELECT documents.id, documents.title, documents.source_id, documents.created_at,
                documents.updated_at, chunks.content
         FROM knowledge_documents documents
         JOIN knowledge_chunks chunks ON chunks.document_id = documents.id AND chunks.ordinal = 0
         WHERE documents.kind = 'memory'
         ORDER BY documents.updated_at DESC`,
      )
      .all()
      .map(mapMemory);
  }

  public getMemory(id: string): MemoryRecord | null {
    const row = this.database
      .prepare(
        `SELECT documents.id, documents.title, documents.source_id, documents.created_at,
                documents.updated_at, chunks.content
         FROM knowledge_documents documents
         JOIN knowledge_chunks chunks ON chunks.document_id = documents.id AND chunks.ordinal = 0
         WHERE documents.kind = 'memory' AND documents.id = ?`,
      )
      .get(`memory:${id}`);
    return row === undefined ? null : mapMemory(row);
  }

  public upsertKnowledgeEmbedding(input: {
    chunkId: string;
    dimensions: number;
    modelId: string;
    vector: Uint8Array;
  }): void {
    this.database
      .prepare(
        `INSERT INTO knowledge_embeddings (chunk_id, model_id, dimensions, vector, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chunk_id) DO UPDATE SET
           model_id = excluded.model_id,
           dimensions = excluded.dimensions,
           vector = excluded.vector,
           updated_at = excluded.updated_at`,
      )
      .run(input.chunkId, input.modelId, input.dimensions, input.vector, Date.now());
  }

  public listMemoryEmbeddings(modelId: string): {
    chunkId: string;
    documentId: string;
    vector: Uint8Array;
  }[] {
    return this.database
      .prepare(
        `SELECT embeddings.chunk_id, chunks.document_id, embeddings.vector
         FROM knowledge_embeddings embeddings
         JOIN knowledge_chunks chunks ON chunks.id = embeddings.chunk_id
         JOIN knowledge_documents documents ON documents.id = chunks.document_id
         WHERE embeddings.model_id = ? AND documents.kind = 'memory'`,
      )
      .all(modelId)
      .map((row) => ({
        chunkId: readString(row, "chunk_id"),
        documentId: readString(row, "document_id"),
        vector: readBlob(row, "vector"),
      }));
  }

  // Workflows
  public listWorkflows(): WorkflowRecord[] {
    return this.database
      .prepare("SELECT * FROM workflows ORDER BY updated_at DESC")
      .all()
      .map(mapWorkflow);
  }

  public getWorkflow(id: string): WorkflowRecord | null {
    const row = this.database.prepare("SELECT * FROM workflows WHERE id = ?").get(id);
    return row === undefined ? null : mapWorkflow(row);
  }

  public createWorkflow(input: {
    fileWatchEnabled?: boolean;
    fileWatchPaths?: string[];
    id: string;
    nextRunAt?: number | null;
    nodesJson: string;
    scheduleCron?: string | null;
    scheduleIntervalMinutes?: number | null;
    scheduleTimezone?: string | null;
    title: string;
    triggerConditionJson?: string | null;
    webhookToken?: string | null;
  }): WorkflowRecord {
    const now = Date.now();
    const interval = input.scheduleIntervalMinutes ?? null;
    this.database
      .prepare(
        `INSERT INTO workflows
         (id, title, nodes_json, last_run_session_id, last_run_at,
          schedule_interval_minutes, schedule_cron, schedule_timezone,
          next_run_at, webhook_token, file_watch_paths_json, file_watch_enabled,
          trigger_condition_json, created_at, updated_at)
         VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.title,
        input.nodesJson,
        interval,
        input.scheduleCron ?? null,
        input.scheduleTimezone ?? null,
        input.nextRunAt ?? (interval === null ? null : now + interval * 60_000),
        input.webhookToken ?? null,
        JSON.stringify(input.fileWatchPaths ?? []),
        input.fileWatchEnabled === true ? 1 : 0,
        input.triggerConditionJson ?? null,
        now,
        now,
      );
    const record = this.getWorkflow(input.id);
    if (record === null) throw new Error("工作流创建失败");
    return record;
  }

  public updateWorkflow(
    id: string,
    patch: {
      fileWatchEnabled?: boolean;
      fileWatchPaths?: string[];
      nextRunAt?: number | null;
      nodesJson?: string;
      scheduleCron?: string | null;
      scheduleIntervalMinutes?: number | null;
      scheduleTimezone?: string | null;
      title?: string;
      triggerConditionJson?: string | null;
      webhookToken?: string | null;
    },
  ): boolean {
    const current = this.getWorkflow(id);
    if (current === null) return false;
    const interval =
      patch.scheduleIntervalMinutes === undefined
        ? current.scheduleIntervalMinutes
        : patch.scheduleIntervalMinutes;
    const nextRunAt =
      patch.nextRunAt === undefined
        ? interval === null
          ? null
          : (current.nextRunAt ?? Date.now() + interval * 60_000)
        : patch.nextRunAt;
    return (
      this.database
        .prepare(
          `UPDATE workflows SET title = ?, nodes_json = ?,
             schedule_interval_minutes = ?, schedule_cron = ?, schedule_timezone = ?,
             next_run_at = ?, webhook_token = ?, file_watch_paths_json = ?,
             file_watch_enabled = ?, trigger_condition_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          patch.title ?? current.title,
          patch.nodesJson ?? current.nodesJson,
          interval,
          patch.scheduleCron === undefined ? current.scheduleCron : patch.scheduleCron,
          patch.scheduleTimezone === undefined ? current.scheduleTimezone : patch.scheduleTimezone,
          nextRunAt,
          patch.webhookToken === undefined ? current.webhookToken : patch.webhookToken,
          patch.fileWatchPaths === undefined
            ? JSON.stringify(current.fileWatchPaths)
            : JSON.stringify(patch.fileWatchPaths),
          patch.fileWatchEnabled === undefined
            ? current.fileWatchEnabled
              ? 1
              : 0
            : patch.fileWatchEnabled
              ? 1
              : 0,
          patch.triggerConditionJson === undefined
            ? current.triggerConditionJson
            : patch.triggerConditionJson,
          Date.now(),
          id,
        ).changes > 0
    );
  }

  public deleteWorkflow(id: string): boolean {
    return this.database.prepare("DELETE FROM workflows WHERE id = ?").run(id).changes > 0;
  }

  public setWorkflowLastRun(id: string, sessionId: string, at: number): void {
    this.database
      .prepare(
        `UPDATE workflows SET last_run_session_id = ?, last_run_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(sessionId, at, at, id);
  }

  public createWorkflowRun(input: {
    id: string;
    runId: string;
    sessionId: string;
    startedAt: number;
    workflowId: string;
  }): WorkflowRunRecord {
    this.database
      .prepare(
        `INSERT INTO workflow_runs (id, workflow_id, session_id, run_id, started_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.workflowId, input.sessionId, input.runId, input.startedAt);
    return {
      id: input.id,
      runId: input.runId,
      sessionId: input.sessionId,
      startedAt: input.startedAt,
      workflowId: input.workflowId,
    };
  }

  public listWorkflowRuns(workflowId: string): WorkflowRunRecord[] {
    return this.database
      .prepare("SELECT * FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC")
      .all(workflowId)
      .map((row) => ({
        id: readString(row, "id"),
        runId: readString(row, "run_id"),
        sessionId: readString(row, "session_id"),
        startedAt: readNumber(row, "started_at"),
        workflowId: readString(row, "workflow_id"),
      }));
  }

  // Chat attachments
  public createChatAttachment(input: {
    charCount: number;
    fileName: string;
    id: string;
    kind: ChatAttachmentRecord["kind"];
    mimeType: string;
    sessionId: string;
    textContent: string;
  }): ChatAttachmentRecord {
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO chat_attachments
         (id, session_id, file_name, mime_type, kind, char_count, text_content, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.sessionId,
        input.fileName,
        input.mimeType,
        input.kind,
        input.charCount,
        input.textContent,
        now,
      );
    const record = this.getChatAttachment(input.id);
    if (record === null) throw new Error("附件创建失败");
    return record;
  }

  public getChatAttachment(id: string): ChatAttachmentRecord | null {
    const row = this.database.prepare("SELECT * FROM chat_attachments WHERE id = ?").get(id);
    return row === undefined ? null : mapChatAttachment(row);
  }

  public listChatAttachments(sessionId: string): ChatAttachmentRecord[] {
    return this.database
      .prepare("SELECT * FROM chat_attachments WHERE session_id = ? ORDER BY created_at")
      .all(sessionId)
      .map(mapChatAttachment);
  }

  public deleteChatAttachment(id: string): boolean {
    return this.database.prepare("DELETE FROM chat_attachments WHERE id = ?").run(id).changes > 0;
  }

  // Custom providers
  public listCustomProviders(): CustomProviderRecord[] {
    return this.database
      .prepare("SELECT * FROM custom_providers ORDER BY created_at")
      .all()
      .map(mapCustomProvider);
  }

  public getCustomProvider(id: string): CustomProviderRecord | null {
    const row = this.database.prepare("SELECT * FROM custom_providers WHERE id = ?").get(id);
    return row === undefined ? null : mapCustomProvider(row);
  }

  public createCustomProvider(input: {
    baseUrl: string;
    id: string;
    models: readonly CustomProviderModel[];
    name: string;
    protocol: CustomProviderProtocol;
    requiresApiKey: boolean;
  }): CustomProviderRecord {
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO custom_providers
         (id, name, protocol, base_url, requires_api_key, models_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.name,
        input.protocol,
        input.baseUrl,
        input.requiresApiKey ? 1 : 0,
        JSON.stringify(input.models),
        now,
        now,
      );
    const created = this.getCustomProvider(input.id);
    if (created === null) throw new Error("自定义 Provider 创建失败");
    return created;
  }

  public deleteCustomProvider(id: string): boolean {
    return this.database.prepare("DELETE FROM custom_providers WHERE id = ?").run(id).changes > 0;
  }

  // Workspaces
  public listWorkspaces(includeRemoved = false): WorkspaceRecord[] {
    const rows = includeRemoved
      ? this.database.prepare("SELECT * FROM workspaces ORDER BY sort_order, created_at").all()
      : this.database
          .prepare(
            "SELECT * FROM workspaces WHERE removed_at IS NULL ORDER BY sort_order, created_at",
          )
          .all();
    return rows.map(mapWorkspace);
  }

  public getWorkspace(id: string): WorkspaceRecord | null {
    const row = this.database.prepare("SELECT * FROM workspaces WHERE id = ?").get(id);
    return row === undefined ? null : mapWorkspace(row);
  }

  public getWorkspaceByRoot(rootPath: string): WorkspaceRecord | null {
    const row = this.database.prepare("SELECT * FROM workspaces WHERE root_path = ?").get(rootPath);
    return row === undefined ? null : mapWorkspace(row);
  }

  public createWorkspace(input: { displayName?: string; rootPath: string }): WorkspaceRecord {
    const existing = this.getWorkspaceByRoot(input.rootPath);
    const now = Date.now();
    if (existing !== null) {
      const displayName = input.displayName?.trim() || existing.displayName;
      this.database
        .prepare(
          "UPDATE workspaces SET display_name = ?, removed_at = NULL, updated_at = ? WHERE id = ?",
        )
        .run(displayName, now, existing.id);
      return this.getWorkspace(existing.id) ?? existing;
    }
    const positionRow = this.database
      .prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS position FROM workspaces")
      .get();
    const sortOrder = positionRow === undefined ? 0 : readNumber(positionRow, "position", 0);
    const id = randomUUID();
    const displayName = input.displayName?.trim() || basename(input.rootPath) || input.rootPath;
    this.database
      .prepare(
        `INSERT INTO workspaces
         (id, root_path, display_name, sort_order, removed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, input.rootPath, displayName, sortOrder, now, now);
    const created = this.getWorkspace(id);
    if (created === null) throw new Error("Workspace 创建失败");
    return created;
  }

  public updateWorkspaceName(id: string, displayName: string): WorkspaceRecord | null {
    this.database
      .prepare(
        "UPDATE workspaces SET display_name = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL",
      )
      .run(displayName, Date.now(), id);
    return this.getWorkspace(id);
  }

  public reorderWorkspaces(ids: readonly string[]): WorkspaceRecord[] {
    const known = new Set(this.listWorkspaces().map((workspace) => workspace.id));
    if (ids.length !== known.size || !ids.every((id) => known.has(id))) {
      throw new Error("Workspace 排序列表不完整");
    }
    const now = Date.now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const statement = this.database.prepare(
        "UPDATE workspaces SET sort_order = ?, updated_at = ? WHERE id = ?",
      );
      ids.forEach((id, index) => {
        statement.run(index, now, id);
      });
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.listWorkspaces();
  }

  public softRemoveWorkspace(id: string): boolean {
    return (
      this.database
        .prepare(
          "UPDATE workspaces SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL",
        )
        .run(Date.now(), Date.now(), id).changes > 0
    );
  }

  public ensureWorkspaceForRoot(rootPath: string): WorkspaceRecord {
    return this.createWorkspace({ rootPath });
  }

  // Command allowlist
  public listAllowedCommandPrefixes(): string[] {
    const value = this.getSetting("allowed_command_prefixes");
    if (value === null) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string").slice(0, 100)
        : [];
    } catch {
      return [];
    }
  }

  public addAllowedCommandPrefix(prefix: string): string[] {
    const values = this.listAllowedCommandPrefixes();
    const next = values.includes(prefix) ? values : [...values, prefix].slice(-100);
    this.setSetting("allowed_command_prefixes", JSON.stringify(next));
    return next;
  }

  public removeAllowedCommandPrefix(prefix: string): string[] {
    const next = this.listAllowedCommandPrefixes().filter((item) => item !== prefix);
    this.setSetting("allowed_command_prefixes", JSON.stringify(next));
    return next;
  }

  // Settings
  public getSettings(): HarnessSettings {
    const row = this.database
      .prepare("SELECT value FROM settings WHERE key = 'approval_mode'")
      .get();
    const value = row === undefined ? null : readString(row, "value");
    const approvalMode: ApprovalMode =
      value === "full_access"
        ? "full_access"
        : value === "auto_approve" || value === "auto"
          ? "auto_approve"
          : "request_approval";
    return {
      approvalMode,
      sandbox: normalizeSandboxSettings({
        allowedDomains: readStringArraySetting(this.getSetting("sandbox_allowed_domains")),
        deniedDomains: readStringArraySetting(this.getSetting("sandbox_denied_domains")),
        profile: this.getSetting("sandbox_profile") ?? undefined,
      }),
    };
  }

  public setApprovalMode(mode: ApprovalMode): void {
    this.setSetting("approval_mode", mode);
  }

  public getDisabledSkills(): string[] {
    return readStringArraySetting(this.getSetting("disabled_skills"));
  }

  public setSkillEnabled(
    scope: "global" | "project" | "system",
    id: string,
    enabled: boolean,
  ): string[] {
    const key = `${scope}:${id}`;
    const current = new Set(this.getDisabledSkills());
    if (enabled) current.delete(key);
    else current.add(key);
    const next = [...current].sort();
    this.setSetting("disabled_skills", JSON.stringify(next));
    return next;
  }

  public setSandboxSettings(input: SandboxSettings): HarnessSettings {
    const sandbox = normalizeSandboxSettings(input);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.setSetting("sandbox_profile", sandbox.profile);
      this.setSetting("sandbox_allowed_domains", JSON.stringify(sandbox.allowedDomains));
      this.setSetting("sandbox_denied_domains", JSON.stringify(sandbox.deniedDomains));
      this.database.exec("COMMIT");
    } catch (error: unknown) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getSettings();
  }

  public getSetting(key: string): string | null {
    const row = this.database.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row === undefined ? null : readString(row, "value");
  }

  public setSetting(key: string, value: string): void {
    this.database
      .prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  public deleteSetting(key: string): void {
    this.database.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }

  /** 按前缀枚举设置项，用于一次性迁移（例如旧版的明文 API Key）。 */
  public listSettingsByPrefix(prefix: string): Array<{ key: string; value: string }> {
    const rows = this.database
      .prepare("SELECT key, value FROM settings WHERE key LIKE ? ESCAPE '\\'")
      .all(`${prefix.replace(/[\\%_]/gu, (character) => `\\${character}`)}%`);
    return rows.map((row) => ({ key: readString(row, "key"), value: readString(row, "value") }));
  }

  private backfillWorkspaces(): void {
    const rows = this.database
      .prepare("SELECT DISTINCT workspace_root AS root FROM sessions")
      .all();
    for (const row of rows) {
      const root = readString(row, "root");
      if (this.getWorkspaceByRoot(root) === null) {
        this.createWorkspace({ rootPath: root });
      }
    }
    this.database
      .prepare(
        `UPDATE sessions
         SET workspace_id = (SELECT id FROM workspaces WHERE root_path = sessions.workspace_root)
         WHERE workspace_id IS NULL`,
      )
      .run();
  }

  private applyMigrations(): void {
    this.database.exec("CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER PRIMARY KEY)");
    const row = this.database.prepare("SELECT MAX(version) AS version FROM schema_meta").get();
    const current = row === undefined ? 0 : readNumber(row, "version", 0);
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(migration.sql);
        this.database
          .prepare("INSERT INTO schema_meta (version) VALUES (?)")
          .run(migration.version);
        this.database.exec("COMMIT");
      } catch (error: unknown) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }
}

function mapSession(row: Row): SessionRecord {
  return {
    archivedAt: readNullableNumber(row, "archived_at"),
    createdAt: readNumber(row, "created_at"),
    id: readString(row, "id"),
    lastSeq: readNumber(row, "last_seq"),
    modelId: readNullableString(row, "model_id"),
    parentSessionId: readNullableString(row, "parent_session_id"),
    piSessionFile: readNullableString(row, "pi_session_file"),
    providerId: readNullableString(row, "provider_id"),
    thinkingLevel: readNullableString(row, "thinking_level"),
    title: readString(row, "title"),
    updatedAt: readNumber(row, "updated_at"),
    workspaceId: readNullableString(row, "workspace_id"),
    workspaceRoot: readString(row, "workspace_root"),
  };
}

function mapWorkspace(row: Row): WorkspaceRecord {
  return {
    createdAt: readNumber(row, "created_at"),
    displayName: readString(row, "display_name"),
    id: readString(row, "id"),
    removedAt: readNullableNumber(row, "removed_at"),
    rootPath: readString(row, "root_path"),
    sortOrder: readNumber(row, "sort_order"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

function mapCustomProvider(row: Row): CustomProviderRecord {
  const protocol = readString(row, "protocol");
  if (
    protocol !== "openai-completions" &&
    protocol !== "openai-responses" &&
    protocol !== "anthropic-messages"
  ) {
    throw new Error(`未知自定义 Provider 协议: ${protocol}`);
  }
  return {
    baseUrl: readString(row, "base_url"),
    createdAt: readNumber(row, "created_at"),
    id: readString(row, "id"),
    models: parseCustomModels(readString(row, "models_json")),
    name: readString(row, "name"),
    protocol,
    requiresApiKey: readNumber(row, "requires_api_key") === 1,
    updatedAt: readNumber(row, "updated_at"),
  };
}

function parseCustomModels(raw: string): CustomProviderModel[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("自定义 Provider 模型配置损坏");
  }
  if (!Array.isArray(parsed)) throw new Error("自定义 Provider 模型配置损坏");
  return parsed.map((item) => {
    if (typeof item !== "object" || item === null) {
      throw new Error("自定义 Provider 模型配置损坏");
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.id !== "string" ||
      typeof record.name !== "string" ||
      typeof record.contextWindow !== "number" ||
      typeof record.maxTokens !== "number" ||
      typeof record.reasoning !== "boolean"
    ) {
      throw new Error("自定义 Provider 模型配置损坏");
    }
    return {
      contextWindow: record.contextWindow,
      id: record.id,
      maxTokens: record.maxTokens,
      name: record.name,
      reasoning: record.reasoning,
    };
  });
}

function mapLiterature(row: Row): LiteratureRecord {
  const status = readString(row, "status");
  if (status !== "ready" && status !== "analyzing" && status !== "done" && status !== "failed") {
    throw new Error(`未知文献状态: ${status}`);
  }
  return {
    charCount: readNumber(row, "char_count"),
    chunkCount: readNullableNumber(row, "chunk_count"),
    createdAt: readNumber(row, "created_at"),
    error: readNullableString(row, "error"),
    fileName: readString(row, "file_name"),
    id: readString(row, "id"),
    pageCount: readNumber(row, "page_count"),
    progress: readNullableNumber(row, "progress"),
    reportJson: readNullableString(row, "report_json"),
    stage: readNullableString(row, "stage"),
    status,
    title: readString(row, "title"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

function mapBoardTask(row: Row): BoardTaskRecord {
  const status = readString(row, "status");
  if (
    status !== "pending" &&
    status !== "in_progress" &&
    status !== "waiting" &&
    status !== "confirmation" &&
    status !== "completed"
  ) {
    throw new Error(`未知任务状态: ${status}`);
  }
  return {
    archivedAt: readNullableNumber(row, "archived_at"),
    completedAt: readNullableNumber(row, "completed_at"),
    createdAt: readNumber(row, "created_at"),
    id: readString(row, "id"),
    objective: readString(row, "objective"),
    position: readNumber(row, "position"),
    rootRunId: readNullableString(row, "root_run_id"),
    sessionId: readNullableString(row, "session_id"),
    status,
    title: readString(row, "title"),
    updatedAt: readNumber(row, "updated_at"),
    workspaceRoot: readString(row, "workspace_root"),
  };
}

function mapChatAttachment(row: Row): ChatAttachmentRecord {
  return {
    charCount: readNumber(row, "char_count"),
    createdAt: readNumber(row, "created_at"),
    fileName: readString(row, "file_name"),
    id: readString(row, "id"),
    kind: readString(row, "kind") as ChatAttachmentRecord["kind"],
    mimeType: readString(row, "mime_type"),
    sessionId: readString(row, "session_id"),
    textContent: readString(row, "text_content"),
  };
}

function mapWorkflow(row: Row): WorkflowRecord {
  return {
    createdAt: readNumber(row, "created_at"),
    fileWatchEnabled: readNumber(row, "file_watch_enabled", 0) === 1,
    fileWatchPaths: readJsonStringArray(row, "file_watch_paths_json"),
    id: readString(row, "id"),
    lastRunAt: readNullableNumber(row, "last_run_at"),
    lastRunSessionId: readNullableString(row, "last_run_session_id"),
    nextRunAt: readNullableNumber(row, "next_run_at"),
    nodesJson: readString(row, "nodes_json"),
    scheduleCron: readNullableString(row, "schedule_cron"),
    scheduleIntervalMinutes: readNullableNumber(row, "schedule_interval_minutes"),
    scheduleTimezone: readNullableString(row, "schedule_timezone"),
    title: readString(row, "title"),
    triggerConditionJson: readNullableString(row, "trigger_condition_json"),
    updatedAt: readNumber(row, "updated_at"),
    webhookToken: readNullableString(row, "webhook_token"),
  };
}

function readJsonStringArray(row: Row, key: string): string[] {
  const raw = readNullableString(row, key);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function mapMemory(row: Row): MemoryRecord {
  return {
    content: readString(row, "content"),
    createdAt: readNumber(row, "created_at"),
    id: readString(row, "id").replace(/^memory:/u, ""),
    sourceId: readNullableString(row, "source_id"),
    title: readString(row, "title"),
    updatedAt: readNumber(row, "updated_at"),
  };
}

function readBlob(row: Row, key: string): Uint8Array {
  const value = row[key];
  if (value instanceof Uint8Array) return value;
  throw new Error(`字段 ${key} 不是 BLOB`);
}

function mapKnowledgeHit(row: Row): KnowledgeHit {
  const kind = readString(row, "kind");
  if (kind !== "literature" && kind !== "workspace" && kind !== "memory") {
    throw new Error(`未知知识文档类型: ${kind}`);
  }
  return {
    chunkId: readString(row, "id"),
    content: readString(row, "content"),
    documentId: readString(row, "document_id"),
    documentTitle: readString(row, "document_title"),
    kind,
    pageEnd: readNumber(row, "page_end"),
    pageStart: readNumber(row, "page_start"),
    section: readNullableString(row, "section"),
    sourceId: readNullableString(row, "source_id"),
  };
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function readString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`数据库字段 ${key} 不是字符串`);
  return value;
}

function readStringArraySetting(value: string | null): string[] {
  if (value === null || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function readNullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`数据库字段 ${key} 不是字符串`);
  return value;
}

function readNumber(row: Row, key: string, fallback?: number): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value === null && fallback !== undefined) return fallback;
  throw new Error(`数据库字段 ${key} 不是数字`);
}

function readNullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`数据库字段 ${key} 不是数字`);
}

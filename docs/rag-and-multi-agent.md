# RAG 与多 Agent 路线

这两块是接下来与“文献”并列的主线。它们共享同一套文档切块与事件基础，但关注点不同：

- **RAG**：让 Agent 能检索自己的文档与记忆，并给出可追溯引用。
- **多 Agent**：让一个任务可以拆分、并行、审查与恢复。

## 1. RAG（FTS baseline 已落地）

### 复用现有资产

- 文献模块的 `chunkDocument()`：页范围、章节、`--- page N ---` 标记。
- 文献正文 `text.json` 与报告中的 citation/evidence。
- SQLite/JSONL：结构化索引与事实源分离。

### 数据模型（新增 migration）

```sql
CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- literature | workspace | memory
  source_id TEXT,                  -- literature id / workspace path / memory id
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE knowledge_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  page_start INTEGER NOT NULL,
  page_end INTEGER NOT NULL,
  section TEXT,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;

CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
  content, chunk_id UNINDEXED, tokenize='unicode61'
);

CREATE TABLE knowledge_embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector BLOB NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
```

### 当前实现（M3-A）

- 文献上传/启动回填时，按页切块写入 `knowledge_documents` / `knowledge_chunks`；
- `knowledge_chunks_fts` 使用 FTS5 `trigram`，中文/英文子串均可检索；短查询走 LIKE；
- `search_knowledge` 工具与 `GET /api/knowledge/search`；
- 文献页顶部搜索框，点击结果跳到对应文献页。

### 检索

1. 查询分词 → FTS5 BM25 候选；
2. 可选向量召回（本地 multilingual embedding）；
3. RRF 融合，按 document/scope 去重；
4. 返回 `{chunkId, documentTitle, pageStart, pageEnd, section, content, score}`。

M3 先实现 **FTS-only** 版本，Embedder 通过端口注入；向量索引可重建，不把向量库当事实源。

### Agent 工具

```text
search_knowledge({ query, limit? })
  → 返回带文献标题/页码/章节的片段
```

- 只读工具，不需要审批；
- 结果中的页码可直接跳转文献全文；
- 后续可加 `read_knowledge_chunk` 按需加载完整上下文。

### 评测

- 10–20 篇论文、50 个问题；
- 指标：recall@k、引用正确率、答案 groundedness、平均 token；
- 先做 FTS baseline，再加向量，看增量。

## 2. 多 Agent（最小闭环已落地）

### 执行模型

- 每个子 Agent 一个独立 pi `AgentSession`（独立上下文、工具、取消）；
- daemon 的 `Orchestrator` 维护执行树与父子关系；
- 事件增加 `executionId` / `parentExecutionId`，复用现有 `HarnessEvent` 通道；
- 审批、预算、深度、并发槽位在 Orchestrator 统一控制；
- 子 Agent 的最终结果写回父 Agent 的 tool result。

### 当前实现（M4-A）

- `spawn_agent` / `wait_agents` / `send_agent` / `stop_agent` 已接入父 Agent 工具集；
- `run_workflow` 一次提交 DAG：节点 id + dependsOn，依赖完成后自动调度，失败向依赖它的节点传播；
- 调度器最多 3 个并发、12 个节点/轮；待调度节点保留完成 promise，`wait_agents` 可等待整个 DAG；
- 子 Agent 使用独立 pi `AgentSession`（in-memory Session），共享模型、workspace 与安全策略；
- explorer/reviewer 只能使用只读工具，worker 可使用全部 workspace 工具；
- 子 Agent 事件（started/message/tool/terminal）带 `executionId` 写入父 Session 事件流；
- 子 Agent 工具审批在审批卡中标记来源；
- Web 三视图：看板（待开始/执行中/需处理/已完成）、依赖图（按拓扑层布局 + 连线）、列表（子对话/工具/结果）；
- 父 Run 结束时中止未完成子 Agent；每轮最多 3 并发、8 个、10 分钟/个。

### 控制工具

```text
spawn_agent({ task, agentType, model?, tools? }) → executionId
wait_agents({ ids, mode: "all" | "any" })
send_agent({ id, message })
stop_agent({ id })
```

### 顶层任务看板 / DAG

- 顶层任务（已实现）：用户创建可验收目标，状态机 pending/in_progress/waiting/confirmation/completed；
  状态从 Run 事件派生，Todo 提供进度，审批未决进入 waiting，Run 成功后等待用户确认；
- DAG（已实现基础调度）：节点=子 Agent，边=dependsOn；支持 fan-out/fan-in，失败向依赖节点传播；
- 已实现：token/时长/节点预算、daemon 重启补偿（未决审批拒绝、未完成子 Agent/Run 标记中断）；
- 后续：嵌套/深度预算、失败节点自动重试、条件分支；
- 可观测：每个节点的 trace、耗时、token、错误。

### UI

- 顶层任务看板（已实现）：五列状态、进度、等待原因、启动/重试/确认；
- 执行树：父子节点、并行分支、失败传播；
- 子 Agent 轨迹：独立消息与工具调用；
- 工作流编辑器（后续）：把 DAG 可视化编排。

## 3. 顺序与验收

1. **RAG M3-A**：文档入库、FTS 检索、`search_knowledge` 工具、文献页搜索框；测试召回与引用。
2. **RAG M3-B**：已实现 FTS + 本地字符 n-gram 哈希向量的 RRF；继续补语义 embedding、记忆引用卡片与评测集。
3. **多 Agent M4**：spawn/wait/send/stop、DAG、任务看板、token/时长/节点预算与重启补偿已完成；继续补嵌套子 Agent、失败重试与可视化编排。
4. **工作流 M4-B**：DAG 可视化编辑器、条件分支、定时/文件触发。

MCP 仍按当前决定后置，不进入这两条主线。

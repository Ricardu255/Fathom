# 架构设计

## 1. 目标与边界

Fathom 是一个**本地优先**的 Agent 运行器：

- Web 只负责输入、投影和审批界面。
- daemon 负责模型调用、Agent 循环、工具执行、持久化与事件广播。
- 工具、策略、Provider 是独立包，不反向依赖 daemon。

M1 只做单用户、单进程、单模型；但包边界按“以后要加 RAG、多 Agent、桌面端”来划分。

```text
┌──────────────────────────── Web (React) ────────────────────────────┐
│  Session 列表 / 对话流 / 工具卡片 / 审批卡 / 文献窗口                │
│  React Query（服务端状态） + Zustand（当前 Session 流式状态）        │
└───────────────▲───────────────────────────────▲─────────────────────┘
                │ fetch /api                     │ EventSource
┌───────────────┴───────────────────────────────┴─────────────────────┐
│ Daemon (Fastify)                                                     │
│  routes → SessionService / LiteratureService                         │
│  SessionService ── AgentRuntime ── ModelClient ── Anthropic          │
│        │                │                                            │
│        │                ├── ToolRegistry ── policy ── tools          │
│        │                └── SessionEventEmitter                      │
│        ├── SessionEventStore (JSONL，事实源)                         │
│        ├── HarnessDatabase (SQLite，索引/设置/文献元数据)            │
│        └── SessionEventBus (transient 广播 + 有限重放)               │
└──────────────────────────────────────────────────────────────────────┘
```

依赖方向：

```text
apps/daemon → packages/{core,providers,tools,policy}
apps/web    → packages/core (仅事件/消息/文献类型)
packages/tools → core + policy
packages/providers → core
```

`packages/core` 不依赖 daemon、文件系统或 Web。

## 2. Agent 循环

`packages/core/src/agent-runtime.ts` 是唯一的运行入口：

1. `startRun(text)` 同步登记 `activeRun`，立即返回 `runId`；因此“刚发出就停止”不会找不到 Run。
2. 发出 `run.started`，追加用户消息。
3. 循环调用 `ModelClient.stream()`：
   - 文本增量 → `text.delta`（transient，只广播不落盘）；
   - 完整 assistant 消息 → `message.completed`；
   - 有 `tool_use` → 依次执行工具，每个工具都产生 `tool.started` / `tool.completed|failed`；
   - 工具结果作为一条隐藏的 user 消息持久化，供下一轮模型请求与重启恢复使用。
4. 无工具调用时结束：`run.completed` / `run.failed` / `run.aborted`。

关键不变量：

- 同一个 Session 同时只有一个 Run。
- `runId` 在开始前登记，而不是在异步准备完成后。
- 每个 assistant `tool_use` 都必须有对应的 `tool_result`；`sanitizeToolPairing()` 在每次请求前补齐，
  避免中止/重启后的残缺历史被 API 拒绝。
- 终止事件（completed/failed/aborted）一定会尝试发出；sink 失败不会掩盖原始错误。

## 3. 事件协议

事件定义在 `packages/core/src/events.ts`。

| 类型                                              | 持久化 | 用途                                 |
| ------------------------------------------------- | ------ | ------------------------------------ |
| `run.started`                                     | 是     | Run 开始，携带模型与工具名           |
| `text.delta`                                      | **否** | 流式文本，仅实时广播                 |
| `message.completed`                               | 是     | 完整 user/assistant/tool-result 消息 |
| `tool.started` / `tool.completed` / `tool.failed` | 是     | 工具生命周期                         |
| `approval.requested` / `approval.resolved`        | 是     | 人工审批协议                         |
| `usage`                                           | 是     | token 用量                           |
| `run.completed` / `run.failed` / `run.aborted`    | 是     | 终态                                 |

序号规则：

- 每个 Session 单调递增，**允许空洞**（持久化失败时序号已消耗）。
- `seq` 在入队时立即分配，避免失败重试复用已落盘序号。
- 读取时只接受严格递增的事件；重复/回退事件会被跳过并记录 warning。
- `SessionEventEmitter` 的 tail 始终吞掉 rejection，单次失败不会毒化后续提交。

## 4. 持久化

### JSONL（事实源）

`apps/daemon/src/storage/event-store.ts`

- 每个 Session：`data/sessions/<sessionId>.jsonl`。
- append 按 Session 串行，写入后 `fsync`。
- 读取只解析完整行；并发追加造成的半行会被忽略，下一次读取会看到完整事件。
- **运行期绝不 truncate**。`repairTrailingLine()` 只在启动时调用：
  - 末行是完整 JSON 但缺换行 → 补换行；
  - 末行损坏 → 截断到最后完整行。
- 中间损坏行会被跳过并记录 warning，不会让 daemon 启动失败。

### SQLite（索引）

`apps/daemon/src/storage/database.ts`

- `sessions`：标题、workspace、last_seq、归档时间、稳定的 `workspace_id`。
- `workspaces`：真实根路径、显示名、排序、软移除时间；旧 `workspace_root` 在启动时回填为工作区。
- `literature`：PDF 元数据、状态、结构化报告。
- `settings`：审批模式与模型连接（Provider、模型、按 Provider 存储的 API Key）。
- `node:sqlite` 同步 API；WAL + busy_timeout。
- 索引更新失败不会让 Run 失败；JSONL 已落盘是权威事实。

## 5. 审批协议

1. 运行时发现工具 `requiresApproval` 且当前不是自动批准模式。
2. 生成 `approvalId`，**先登记 pending promise**，再发 `approval.requested`。
3. 前端展示批准/拒绝；`POST /api/sessions/:id/approvals/:approvalId` 调用 `runtime.resolveApproval()`。
4. 运行发出 `approval.resolved`，继续或把拒绝写回工具结果。
5. Abort 会解析所有 pending 审批为拒绝，并清理映射。

审批只影响工具执行，不改变路径策略：即使自动批准，路径越界仍会被拒绝。

三档全局策略：

- `request_approval`：副作用工具逐次等待用户批准。
- `auto_approve`：自动执行，保留事件与审计。
- `full_access`：自动执行所有工具；路径边界、受保护目录和 Plan 模式仍然生效。

设置页、首页 Composer 与会话页共用同一份 `approval_mode`。

### 用户提问协议（HITL）

- `request_user_input` 由 daemon 注入父 Agent 与子 Agent；每个提问生成 `inputId`，先登记 pending promise，再发 `input.requested`。
- 回答经 `POST /api/sessions/:id/inputs/:inputId` 校验（必填、单选/多选选项归属）后写 `input.resolved`；重复提交会被拒绝。
- 超时（默认 300 秒，可配置 10 秒～30 分钟）、AbortSignal、Run 中止与 daemon 重启都会写 `input.expired`，避免前端永久等待。
- 快照包含未决提问，SSE 重连后仍可继续回答；daemon 重启时未决提问按 `aborted` 收口。
- 提问卡片支持分页、单选自动前进、多选、自定义输入与提交错误提示。

## 6. SSE 契约

`GET /api/sessions/:id/events?afterSeq=N`

- 先注册断连监听，再订阅、再读取快照，避免快照期间断开导致订阅泄漏。
- 发送顺序：持久化事件（`afterSeq` 之后）→ transient 重放缓冲 → 快照期间的实时事件（按 seq 排序）。
- 用 `lastSentSeq` 去重；Web 断线重连使用 `afterSeq` 查询参数；服务端尚未读取 SSE 原生 `Last-Event-ID` 请求头。
- 心跳为注释行 `: heartbeat`，不进入事件数据。
- 每个 Session 一个连接；**只为当前可见 Session 订阅**，后台 Session 不各开一条 EventSource。

## 7. 安全边界（M1）

- daemon 只监听回环地址；`HARNESS_HOST` 非回环直接拒绝启动。
- Host 白名单：daemon 地址 + Web 开发/生产地址。
- 所有非 GET/HEAD/OPTIONS 请求必须同时满足：
  - `Origin` 在白名单；
  - `X-Harness-Request: 1`。
- 不基于 URL 前缀做鉴权（避免 `%61` 等编码绕过）；未来加 token 时应在路由级 `preHandler` 做。
- 文件工具：
  - 相对路径基于 workspace；
  - `realpath` 后必须仍在 workspace 内；
  - 受保护目录（`data/`）不可读写；
  - 符号链接不能把目标带到 workspace 外。
- 命令工具：默认逐次审批；高风险命令在 UI 中单独标记；进程超时/取消时回收进程树。
- 还没有多用户认证；不要把端口暴露到非回环地址。

## 8. 安全与可靠性红线（来自参考项目审查）

这些问题在参考项目里真实存在，本项目在实现时直接规避：

1. **不要用原始 URL 前缀做认证**。Fastify 路由会 decode `%61`，但 `request.url` 仍是编码形式；
   前缀判断会被绕过。鉴权放到路由级 hook。
2. **事件队列的 tail 必须处理 rejection**。否则一次磁盘错误会让该 Session 永久无法再发事件，
   并产生 unhandledRejection。
3. **外部写事件后必须同步的 `nextSeq`**。daemon 直接写 JSONL 后再跑 Agent，
   新 Run 的首个事件会与已落盘 seq 冲突。本项目只允许 runtime 通过 emitter 写事件。
4. **读取时不要 truncate**。并发 append 时会把刚写完的完整事件截掉。本项目只在启动时修复。
5. **不要为每个后台 Session 开常驻 SSE**。浏览器 HTTP/1.1 同源连接有限，容易把普通请求饿死。
6. **不要把每个 token 直接写全局 store**。文本增量按动画帧合并。
7. **不要用 PowerShell `-Command` 拼接不可信路径**。`;`/`$()` 会被当成语句执行。
   本项目的文件打开功能没有引入这个调用；Windows 下应使用环境变量或专用参数封装。
8. **Windows 不要依赖 POSIX mode 位**。Node 在 Windows 上合成 `0o666`，凭据文件权限检查会误判。
   本项目不对文件权限做 POSIX 假设。
9. **OAuth 弹窗要切断 `window.opener`**；外部链接要 `noopener noreferrer`。
10. **渲染模型输出使用 sanitize**。本项目 Markdown 走 `react-markdown` 默认转义，
    不启用 raw HTML；未来接入其他渲染器时保持同样的 sanitize 策略。

## 9. 双引擎：pi（默认）与 builtin（回退）

M2 起 daemon 支持两种执行引擎，通过 `HARNESS_ENGINE` 选择：

- **pi**（默认）：`@earendil-works/pi-coding-agent` 的 `AgentSession` 负责工具循环、Session 持久化、
  上下文压缩、follow-up 队列、自动重试与 `agent_before_settle` 续轮。我们只保留事件投影、审批、HTTP/SSE 与 Web。
- **builtin**：M1 的自建 `AgentRuntime`，保留用于对比与故障排查；M2 功能已同步但不再作为主线。

pi 引擎的关键文件：

```text
apps/daemon/src/pi/
├── model.ts            # ModelRuntime + Provider / faux mock
├── tools.ts            # 我们的 Tool → pi ToolDefinition（含审批）
├── approval.ts         # approval.requested/resolved
├── event-bridge.ts     # pi AgentSessionEvent → HarnessEvent
└── session-engine.ts   # 一个 Session = 一个 pi AgentSession
```

事实源分工：

- pi `SessionManager` 的 JSONL（`data/pi-sessions/`）是模型上下文事实源；
- 我们的 `data/sessions/<id>.jsonl` 是 UI/审计事件投影；
- SQLite 保存 Session 元数据、`pi_session_file`、设置与文献索引。

安全取舍：pi 引擎关闭内置工具、外部扩展、Skill、Prompt 模板、主题和 workspace 上下文文件的自动加载
（`noTools: "builtin"`、`noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles`），
只使用我们的工具、策略、审批和 system prompt。这避免了任意仓库/用户目录中的扩展代码被自动执行。
pi 的 MCP 扩展也不加载。

workspace 根目录的 `AGENTS.md` 由我们自己的 `loadAgentsContext()` 读取：路径走与文件工具相同的
realpath/越界检查，最多读取 16 KiB，缺失或不可读时静默跳过；内容作为独立段落注入主 Agent 与子 Agent
的系统提示，并明确“项目指令不得覆盖安全规则或用户明确要求”。

### 模型设置

- 设置页通过 `PUT /api/settings/model` 选择 Provider/模型并写入 API Key；Provider 列表来自 pi-ai 的 ModelRuntime，只展示支持 API Key 认证的 Provider。
- 自定义 Provider 使用 `custom:<uuid>` 稳定 ID，保存在 SQLite；启动时通过 `ModelRuntime.registerProvider` 注册 OpenAI-compatible / Anthropic-compatible 端点与模型，API Key 与其他 Provider 一样按 ID 存储，不进入模型配置 JSON。
- API Key 按 Provider 写入 SQLite settings，并同步到 pi 的 `auth.json`；`GET /api/settings` 只返回 `apiKeyConfigured` / `apiKeySource`，不回传密钥；日志与错误消息也不包含密钥。
- Provider OAuth 由 daemon 调用 pi `ModelRuntime.login()`，把 auth_url、设备码、progress 和交互式 prompt 投影为登录会话；Web 轮询会话并提交回答，取消会中止底层流程，凭据由 pi CredentialStore 保存。
- `ProviderSettingsService` 复用同一个 `PiModelSetup` 与 ModelRuntime；保存设置只更新模型、Provider、Mock 标记和运行时 Key。每个 `PiSessionEngine` 在创建时快照模型配置，因此已打开的 Session 及其子 Agent 继续使用原模型，避免运行中上下文错配。
- `GET /api/settings/models?providerId=` 按需返回模型目录，避免设置接口携带全部 Provider 的模型列表；`GET /api/models` 返回带上下文窗口、输出上限、推理能力与配置状态的完整目录。
- Session 保存 `provider_id`、`model_id`、`thinking_level`；`PATCH /api/sessions/:id/model` 只在空闲时切换，引擎对已打开 Session 调用 pi `setModel` / `setThinkingLevel`，新 Run 使用新选择。
- 默认 Provider/Model/推理强度持久化在 settings；首页选择仅覆盖当前新会话，设置页修改默认值。
- daemon 启动时读取持久化配置；真实模型缺少 Key 或配置失效时回退到本地测试 stream，保证客户端仍能打开设置页修复配置。

## 10. RAG 与多 Agent（M3/M4）

### RAG

- 文献上传/启动回填时按页切块，写入 `knowledge_documents` / `knowledge_chunks`；
- FTS5 `trigram` 支持中英文子串检索，短查询走 LIKE；
- `search_knowledge` 是只读工具，经 `ToolContext.searchKnowledge` 注入，pi/builtin 引擎共用；
- `GET /api/knowledge/search` 供 Web 搜索框使用。

向量检索是下一步：`knowledge_embeddings` 表已预留，Embedder 通过端口注入，索引可重建。

### 多 Agent

- `SubAgentOrchestrator` 为父 Session 管理平级子 Agent；
- 每个子 Agent 是独立 pi `AgentSession`（in-memory Session），共享模型、workspace、审批与知识检索；
- `spawn_agent` / `wait_agents` / `send_agent` / `stop_agent` 由 daemon 注册为自定义工具；
- 子 Agent 事件投影为 `subagent.*`，带 `executionId`；Web 用子 Agent 面板展示；
- explorer/reviewer 只读，worker 可写；每轮 3 并发、8 个、10 分钟；
- 父 Run 结束时中止未完成的子 Agent，避免后台泄漏。

### 用户任务看板

- `BoardTaskService` 维护顶层任务：标题、目标、工作区、`sessionId` / `rootRunId`；
- 状态机为 pending → in_progress → waiting / confirmation → completed；
- 状态不靠前端猜：服务读取该 Run 的事件，审批未决 → waiting，Run 失败/中止 → waiting，
  Run 成功 → confirmation，用户确认后才写 completed；
- Todo 事件派生进度与当前步骤，`file.changed` 去重后派生变更文件数；
- `POST /api/board/tasks/:id/start` 复用或创建 Session，再调用 `startRun`；重试会切换新 Run。

### 工作状态重置

- 每个新顶层 Run 的 `run.started` 会在事件投影层清空上一 Run 的 Plan 与 Todos，避免旧工作状态污染新任务；
  原始 `plan.created` / `todos.updated` 事件仍保留在 JSONL 中，可回放与审计。
- 子 Agent 事件不产生新的顶层 `run.started`，因此不会误清父 Run 的工作状态。

### 上下文检查点（X-01～X-03）

- 每次 `context.compacted` 除摘要与 token 数外，还写入结构化 `checkpoint`：目标、约束、决策、已完成、待完成、阻塞、下一步。
- 结构化状态优先从事件投影确定性派生：最近用户消息作为目标，Todo 状态映射完成/待办/阻塞，未决审批、未决提问与最近工具失败进入阻塞；pi 压缩摘要若包含中英文分节标题，则补充约束、决策等字段。
- 版本链字段：`checkpointId`、`previousCheckpointId`、`coveredFromSeq`、`coveredToSeq`、`trigger`（`auto` / `manual`）。检查点 ID 在事件落盘成功后才推进，失败的写入不会让链条指向未持久化版本。
- `GET /api/sessions/:id/checkpoints` 列出检查点；`GET .../checkpoints/compare?base=&target=` 返回字段级 added/removed；`POST .../checkpoints/:id/restore` 仅在 Session 空闲时允许。
- 恢复会追加 `context.checkpoint_restored` 事件，并把格式化后的检查点作为下一次 Run 的隐藏前缀注入；daemon 重启后如果恢复事件之后还没有新 Run，会重新应用。Web 会话页的“上下文检查点”按钮提供双版本对比与恢复入口。

### Context 审计与编辑（X-05～X-09）

- `search_history` 是只读工具：扫描当前 Session 的完整 JSONL，按关键词返回最近的有界片段、可见消息序号与事件 seq；单条片段上限 400 字，结果最多 20 条。
- 每次模型请求（pi `turn_start`）写入 `request.snapshot`：system prompt、工具定义、消息数组与估算输入 token；base64 图片替换为长度标记，超长文本截断，超过 512 KiB 时丢弃最旧消息并标记 `truncated`。
- 自动续轮是显式协议：system prompt 说明只有用户要求自主迭代时才在未完成时输出 `<!-- FATHOM_CONTINUE -->`；daemon 在 `message_end` 只记录模型意图，pi 的 `agent_before_settle` 边界追加一条隐藏 `custom_message` 并请求 `continue`，上限由 `HARNESS_AUTO_FOLLOW_UP_MAX` 控制（默认 8，0 关闭）。内部续轮消息写入 JSONL 但标记 `hidden`，不进入 Web 快照。
- `POST /api/sessions/:id/rewrite` 先用 `excludeFromTimestamp` 分支到该用户消息之前，再以新文本启动 Run；旧分支与原始消息保持不变。
- 文件撤销/重放读取该 Session 的全部 `file.changed`，按路径取最早 `before` 与最新 `after`。先校验所有文件当前内容是否等于预期，再统一写入；任一冲突返回 409 且不产生部分写入。

### 对话体验与渲染（R-01～R-08）

- 会话页支持“对话 / 轨迹 / 文件”三视图；轨迹复用 `TraceView`，文件视图复用 `WorkspaceBrowser`。
- 用户消息支持复制、编辑重跑、重试与 fork；助手消息支持复制。轮次导航根据用户消息锚点与滚动位置更新。
- pi `thinking` block 映射为 `thinking` content 与 `reasoning.delta` transient 事件；Web 流式显示“正在思考”，完成后折叠。
- 工具结果进入前端时只保留 16k 预览；展开时按 `toolCallId` 从 JSONL 读取完整结果。文件 Inspector 提供扩展名图标、目录树、预览/编辑与桌面系统打开。

### SRT 沙箱与凭据脱敏

- `packages/sandbox` 使用 `@anthropic-ai/sandbox-runtime` 包装 `run_command`；`off` 与 `full_access` 走宿主，`read_only` / `workspace_write` 进入 SRT。
- 文件规则：workspace 只读/可写按 Profile，daemon 数据目录 deny，临时目录可写；网络规则使用沙箱 allow/deny 域名。
- SRT 全局代理按命令串行持有，命令结束即 reset；`HARNESS_SANDBOX_CREDENTIAL_NAMES` 指定的环境变量以 mask 模式交给 SRT。
- SRT 初始化或运行失败时返回明确错误，不静默降级到宿主执行。

### Durable 续跑、Session FTS 与语义记忆

- 中断 Run 可由用户触发 `POST /api/sessions/:id/resume`：从 JSONL 重建上次目标、输出与成功工具，生成安全续跑提示；不重放未知副作用。
- Session 消息在事件落盘后写入 `session_messages_fts`（FTS5 trigram）；搜索短查询走 LIKE，归档 Session 排除；索引可从 JSONL 重建。
- Memory 支持 OpenAI-compatible Embedding 端点（`HARNESS_EMBEDDING_*`），与 FTS 候选做 RRF；向量服务失败时退化为关键词召回。

### 用量与 Trace（U-01～U-07）

- `UsageService` 从每个 Session 的 JSONL 聚合 `usage` 与子 Agent 终态 usage；按 Session `lastSeq` 缓存，归档 Session 也计入。费用通过 pi 模型目录的 `cost`（每百万 token）估算，未知价格返回 `costComplete=false`。
- `GET /api/usage` 支持 from/to、Provider、Model 过滤，返回每日桶、Provider/Model 汇总、请求数、压缩次数与子 Agent 数。
- `TraceService` 把事件投影为 Run → Request（`request.snapshot` + 后续 `usage`）→ Tool/Approval/Compaction/Sub Agent；工具结果与请求快照都有 16k 预览上限。
- Web 提供 `/usage` 热力图与趋势页、`/s/:id/trace` 执行轨迹页；请求可打开 System Prompt/工具定义/消息页签，子 Agent 可通过 executionId 切换。

### Skills（S-01～S-07）

- Skill 是包含 `SKILL.md` 的目录；frontmatter 只要求 `name`（小写字母/数字/连字符）与 `description`，正文上限 200k 字符，文件上限 256KB。
- 发现顺序为 system → global → project，同名按 project 覆盖；禁用记录按 `scope:id` 保存，禁用的高优先级 Skill 不会回退到低优先级同名 Skill。
- 系统提示只注入启用 Skill 的名称与描述；正文和资源由 `load_skill` 按需读取，资源路径必须留在 Skill 目录内且 ≤512KB。
- `find_skill` / `get_skill` / `load_skill` / `skill_creator` 注入主 Agent 与子 Agent；`skill_creator` 写入 `<workspace>/.fathom/skills/<name>/SKILL.md` 并需要审批。
- Composer 输入 `$` 从当前 Session 的启用 Skill 中选择并插入 `$name`；daemon 解析去重后把名称/描述作为隐藏上下文注入，用户消息保留原文回显。
- 设置页可查看 system/global/project、切换启用状态、查看正文与资源列表；安装仅接受 GitHub `owner/repo`，60 秒超时、最多 200 文件/5MB、拒绝符号链接、失败清理。

### Web、文档与图片工具（T-01～T-06）

- `web_fetch` 只接受 http/https，拒绝 URL 凭据、localhost、私网/回环/链路本地/保留地址与云元数据地址；每次重定向都重新做 DNS 校验。响应流最多读取 2MB，返回文本最多 120k 字符，超时默认 15 秒。
- `web_search` 调用 `HARNESS_SEARXNG_URL/search?format=json`，返回标题、URL、摘要；未配置时返回可操作错误，不静默失败。
- `view_image` 走 workspace realpath/受保护目录策略，支持 PNG/JPEG/GIF/WebP，单文件 8MB、边长 4096；模型不具备图片输入能力时直接拒绝。图片作为 image content 进入 pi 工具结果。
- `read_document` 复用附件模块的 PDF/DOCX/PPTX/XLSX/文本抽取，单文件 15MB、返回最多 200k 字符。
- `view_pdf_page` 用 unpdf 渲染指定页为 PNG，并限制 30MB 源文件与 8MB 渲染结果；渲染依赖运行环境提供 `@napi-rs/canvas`，缺失时返回明确错误。
- `wait_background_command` 与 `stop_background_command` 共用 BackgroundCommandService 的进程身份，最多等待 120 秒并返回最近输出。

### 工具守卫、沙箱与宿主重跑（T-07～T-11）

- `ToolExecutionGuard` 提供每 Session 并发上限（4）、单次超时（120 秒）与同参数副作用去重；失败结果不缓存，新 Run 开始时清空去重表。文件写入另有进程级 `WorkspaceWriteCoordinator`：按 realpath 串行，读/写工具记录内容指纹，写入前发现目标已被其他执行修改时返回 `WORKSPACE_CHANGED`。Shell 命令不在该锁内，不提供事务隔离。
- 独立 `packages/sandbox` 定义 `off` / `read_only` / `workspace_write`：`read_only` 拒绝写文件、命令、子 Agent 与记忆写入；网络边界先检查 deny，再检查 allow（留空 allow 表示不限制）。
- 沙箱设置保存在 SQLite settings，通过 `PUT /api/settings/sandbox` 原子替换；工具调用的阻断与网络检查实时读取设置，不需要重启。
- 沙箱拒绝副作用工具时会发起一次 `force` 审批，绕过自动批准模式，明确询问是否以宿主权限重跑；计划模式的硬阻断不能被绕过。

### 多模态、steering 与 fork

- 图片以 base64 `ImageBlock` 进入消息协议，pi 侧映射为 `ImageContent`；事件回放保留图片，而不是降级为文本。
- 运行中普通发送进入 follow-up 队列；`POST /api/sessions/:id/steer` 调用 pi `steer()`，在当前工具后注入。
- `POST /api/sessions/:id/fork` 默认用 `SessionManager.forkFrom()` 复制最新 pi 历史；带 `fromTimestamp` 时按历史用户消息 entry 调 `createBranchedSession()`，并只复制 cutoff 前的 JSONL 事件；新 Session 记录 `parent_session_id`，复制时把未决审批收口为拒绝；Web 用该字段构建分支森林并支持跳转。
- `POST /api/sessions/:id/rewrite` 在 fork 基础上排除目标消息（pi entry 取 `parentId`），再以改写文本启动新 Run；Web 用户消息提供“编辑并重跑”。
- `GET /api/sessions/compare` 按消息签名求共同前缀，返回两侧分叉后的消息与文件变更；`POST /api/sessions/:id/merge` 复制目标分支并在 pi 历史/JSONL 中追加来源分支摘要，生成新的合并分支。
- `@` 文件引用通过 `GET /api/sessions/:id/files` 获取结构化工作区列表，输入框只插入路径文本，不改变消息协议。

### 长期记忆

- 每条记忆复用 `knowledge_documents(kind='memory')` + 单 chunk，不新增表。
- 检索为 FTS/BM25 + 本地字符 n-gram 哈希向量的 RRF；Embedder 是端口，后续可替换为语义模型。
- 工具 `save_memory` / `search_memory` / `forget_memory` 由 daemon 注入父 Agent，写操作走审批；Web 提供独立记忆页。
- 每个新 Run 检索最多 5 条记忆，作为隐藏前缀进入 pi prompt；事件桥从用户消息中剥离前缀，另写 `memory.recalled` 供 Web 显示注入标记。

### 子 Agent 预算与恢复

- token、单个子 Agent 时长、每轮节点数、DAG 节点数均可配置；token 预算按累计 usage 判断，触发后中止并写预算错误码。
- `SessionManager` 的子 Agent 上下文仍在内存；daemon 重启只做状态对账：
  未决审批 → denied，未完成子 Agent → aborted（`SUBAGENT_INTERRUPTED`），未完成 Run → aborted（`DAEMON_RESTART`）。
- 恢复扫描幂等：已结束会话不写事件；补偿后 Board/Session 快照自动进入 waiting。

### 三方代码合并

- 以事件里的 `before/after` 作为分支文件快照；用共同消息 cutoff 计算 base、ours、theirs。
- `node-diff3` 做行级三方合并；同一区域冲突、删除/修改冲突会阻断自动应用。
- `GET /api/sessions/merge-preview` 返回逐文件预览；`POST /api/sessions/:id/merge-code` 在无冲突时写入工作区并创建合并分支。

### Git 面板

- `GitService` 通过 `execFile("git")` 执行 status/diff/add/reset/commit，禁用交互凭据。
- Web Git 抽屉展示分支、变更、diff、暂存/取消暂存与提交；不支持 rebase/merge 等高风险操作。

### Electron 桌面端

- `apps/desktop` 提供 Electron 主进程/预加载；最终产品形态是图形客户端，不做终端/CLI。
- 启动时选择空闲回环端口，用 Electron 的 Node 模式启动 esbuild 打包的 daemon sidecar，健康检查通过后加载本地 Web。
- 窗口使用隐藏标题栏 + `titleBarOverlay`；React 顶部集成状态栏与侧栏品牌是拖拽区，原生窗口按钮不覆盖内容。
- 默认浅色、清新配色；客户端数据存放在用户目录，daemon 随客户端退出而清理。
- `electron-builder` 打包 `daemon.mjs` 与 Web 静态资源；不包含交互式 PTY/终端。
- NSIS 安装器使用非 one-click 模式，允许用户选择安装目录。
- 数据与缓存位置保存在固定 `userData/storage.json`；数据目录在启动 daemon 前迁移复制，失败回退旧目录；缓存目录只切换不迁移；重启会等待 daemon 退出。

### 后台命令

- `BackgroundCommandService` 按 Session 管理子进程：启动、列表、读取输出、停止；只继承白名单环境变量，限制每 Session/全局并发，保留 1 MiB 捕获与 64 KiB 视图，并用独立 watchdog 在 daemon 崩溃时回收进程树。沙箱 Profile 下长驻后台命令会被明确拒绝，不静默降级到宿主。
- 输出内存上限 256KB；停止使用进程组/`taskkill /T` 清理进程树；daemon 关闭时统一 `stopAll`。
- Agent 工具：`start_background_command`（审批）、`list/read/stop_background_command`；Web 也提供同能力抽屉，便于直接查看 dev server 输出。

### 工作区文件编辑

- `GET /api/sessions/:id/file` / `PUT` 通过 `WorkspaceService` 读写；路径走同一套 realpath/受保护目录策略。
- 只支持 UTF-8 文本、单文件上限 1MB；写入使用临时文件 + rename 原子替换。
- Web 工作区抽屉复用 `GET /files` 的目录树，支持过滤、预览、编辑与保存；不提供二进制/超大文件编辑。

### 文档附件

- 上传到 `chat_attachments`：PDF 用 unpdf、DOCX 用 mammoth、PPTX 用 JSZip 解析 `ppt/slides/*.xml`、XLSX 用 SheetJS、文本/Markdown 直接解码。
- 消息只传附件 id；daemon 校验归属并按总量截断，拼成隐藏上下文前缀注入 pi prompt。
- `attachment.context` 事件携带文件名/类型，Web 用附件条展示；实时流与快照回放一致。

### Plan 模式

- `POST /api/sessions/:id/messages` 支持 `planMode: true`；pi prompt 注入计划模式前缀。
- `toPiTools` 在审批前调用 `blockedToolReason`，硬阻断写入、命令、子 Agent 与记忆写入工具；即使自动批准也不会绕过。
- 该标记只对 pi 引擎生效，builtin 明确拒绝；UI 在 Composer 中切换。
- 计划 Run 结束后写入 `plan.created`；Web 显示计划卡，批准后以 `planMode: false` 自动发起执行 Run，新 Run 的 `run.started` 清空计划卡。
- 计划卡支持自然语言修改：用户填写反馈后以 `planMode: true` 重新发起一轮，要求基于上一版输出完整的下一版计划；新版覆盖 `plan.created`，旧版仍保留在会话历史中。

工作流编辑器已接入直接调度：`POST /api/sessions/:id/workflows` 不经过父模型，直接调用 Orchestrator 并写同一套 Run/子 Agent 事件；`workflows` 表保存节点 JSON、最近运行 Session 与时间，`workflow_runs` 记录每次运行；调度器按 cron/时区计算 `next_run_at`，`WorkflowFileWatcher` 监听相对路径并按 glob 条件过滤，Webhook 通过 token 与内容条件在非同源请求下触发；`POST /api/workflows/:id/run` 可复用已保存版本。嵌套子 Agent、复杂条件表达式与语义 embedding 是后续 M4-B。

## 11. 扩展点

### 新增工具

1. 在 `packages/tools/src/` 定义 `Tool`（zod 参数 + `parse` + `execute`）。
2. 标记 `requiresApproval`。
3. 在 `createWorkspaceTools()` 注册。
4. 加一条策略测试（路径/参数边界）。

### 新增 Provider

实现 `ModelClient.stream()`，把厂商流事件映射成 `ModelResult`。循环、工具、审批不需要改。
多 Provider 路由放在 daemon 的 `ModelClient` 选择层，而不是 Agent 循环里。

### 新增持久化投影

事件已经包含所需数据；优先在 Web 侧派生，不要为了 UI 往 JSONL 里写入重复事实。

### 子 Agent / RAG / MCP

- 子 Agent：新增 `packages/core/src/sub-agent-tree.ts`，复用 `AgentRuntime` 与同一事件 emitter；
  预算、深度、取消、事件归属必须先在协议里定义。
- RAG：新增 `packages/memory`，通过 repository/embedder 端口接入；SQLite 作为事实源，
  FTS/向量索引可重建；不把向量库当唯一事实。
- MCP：**当前明确不实现**。未来作为独立 `packages/mcp` + daemon 适配层接入工具注册表，
  不改变现有 Policy/审批链。

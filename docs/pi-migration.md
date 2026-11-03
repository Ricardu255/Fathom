# pi 内核迁移

## 决策

M2 起，Agent 执行内核从自建循环切换到 pi 官方 SDK：

- **执行内核**：`@earendil-works/pi-coding-agent@1.4.0`
- **模型/Provider**：`@earendil-works/pi-ai@1.4.0`（Anthropic + 内置 Provider 目录）
- **产品外壳**：保留我们的 Fastify daemon、SSE 事件协议、React Web、审批 UX、文献窗口、SQLite/JSONL 投影
- **不实现**：MCP（按当前决定后置）

旧的自建引擎保留为 `HARNESS_ENGINE=builtin` 回退，用于对比和故障排查；默认 `HARNESS_ENGINE=pi`。

## 为什么

pi SDK 已经覆盖 M2 的基础设施：

| 能力                          | pi SDK                                                   | 我们自己写           |
| ----------------------------- | -------------------------------------------------------- | -------------------- |
| Session JSONL / 分支 / 恢复   | `SessionManager`                                         | 只保留 UI 事件投影   |
| 上下文压缩                    | `compact()` + 自动阈值                                   | 映射事件与快照       |
| 运行中队列 / steer / followUp | `prompt({streamingBehavior})` / `steer()` / `followUp()` | 暴露 API 与 UI       |
| 自动重试                      | `auto_retry_*` 事件                                      | 映射到 `model.retry` |
| 工具循环 / 并行执行           | `Agent` + `ToolDefinition`                               | 包装审批与策略       |
| Provider / 模型目录           | `ModelRuntime` + `pi-ai`                                 | 配置 API Key 与模型  |

我们真正需要自己做的：Web 工作台、审批、路径/命令策略、文献解析、RAG、多 Agent 编排、桌面端。

## 集成结构

```text
apps/daemon/src/pi/
├── model.ts            # ModelRuntime + Anthropic + faux mock
├── tools.ts            # 我们的 Tool → pi ToolDefinition + 审批包装
├── approval.ts         # approval.requested/resolved 协调器
├── event-bridge.ts     # pi AgentSessionEvent → 我们的 HarnessEvent
└── session-engine.ts   # 一个 Session = 一个 pi AgentSession
```

`PiSessionService` 与旧 `SessionService` 实现同一 `SessionController` 契约，server 不感知引擎差异。

### 事实源

- **模型上下文**：pi `SessionManager` 的 JSONL（`data/pi-sessions/`）。
- **UI/审计事件**：我们的 `data/sessions/<id>.jsonl`（由 event bridge 投影）。
- **索引/设置**：我们的 SQLite。
- 两者通过 Session id 关联；`sessions.pi_session_file` 保存 pi 文件路径。

UI 快照优先使用我们的投影事件；因此即使 pi 会话文件存在，Web 的历史仍来自可回放的 `HarnessEvent`。

### 工具与审批

pi 没有内置权限系统。我们把 `packages/tools` 的工具转成 pi `ToolDefinition`：

1. pi 先做 schema 校验；
2. 我们的包装层再 `parse`；
3. `requiresApproval` 为真时调用 `PiApprovalCoordinator`，发 `approval.requested` 并等待 HTTP 决定；
4. 工具结果中的 `fileChanges` / `todos` 直接投影成 `file.changed` / `todos.updated`。

内置 pi 工具通过 `noTools: "builtin"` 关闭，避免绕过我们的政策与审批。

### 事件映射

| pi 事件                                   | 我们的 HarnessEvent                                |
| ----------------------------------------- | -------------------------------------------------- |
| `agent_start`                             | `run.started`                                      |
| `message_end` (user/assistant/toolResult) | `message.completed`                                |
| `message_update` (`text_delta`)           | `text.delta`                                       |
| `tool_execution_start/end`                | `tool.started` / `tool.completed                   | failed` |
| `compaction_start/end`                    | `context.compaction_started` / `context.compacted` |
| `auto_retry_start/end`                    | `model.retry`                                      |
| `agent_settled`                           | `run.completed` / `run.failed` / `run.aborted`     |

## 已验证（spike + 端到端）

- pi Session 持久化：`SessionManager.create/list/open`。
- 自定义工具执行与工具结果回填。
- `followUp` 队列：运行中第二次 prompt 进入 queue_update，最终按序执行。
- Mock：pi-ai `faux` provider 覆盖 `session.agent.streamFunction`，无需 API Key。
- daemon 端到端：对话、`list_files`、`write_file` 审批、文件落盘、Todos、排队、SSE 事件投影。

## 剩余工作

- 分支（pi `SessionManager` 的 fork/tree）暴露到 Web。
- 附件（pi `prompt({images})` 已支持，Web 输入框未接）。
- 系统提示词/项目上下文：当前通过 `DefaultResourceLoader` 注入我们的 system prompt，并关闭外部扩展/Skill 自动加载。
- 旧 `builtin` 引擎的快照/队列 API 与 pi 引擎保持一致，但不再作为主线维护。
- 迁移旧会话：旧引擎没有 `pi_session_file`；这些会话仍可查看 UI 历史，但 pi 模型上下文为空。开发期直接新建会话即可。

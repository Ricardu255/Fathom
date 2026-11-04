# 参考项目采纳清单

> 目标：只吸收能补齐 Fathom 短板、且与「本地单用户 GUI 工作台」定位一致的内容。
> 参考项目：`D:\code\TypeScript\pi-main`（pi 官方内核）、`D:\code\TypeScript\pi-harness-main`（完整 Harness）。
> 状态核对时间：2026-11-03，逐项对照源码与测试。
> 状态以**符号名与测试文件**为准，不引用会漂移的行号。
> 明确排除 CLI/TUI、插件市场、Computer Use 等与产品形态不符的方向。

## 0. 判断标准

- **保留 Fathom 的差异化**：审批、路径策略、沙箱、JSONL 事实源、多 Agent DAG、工作流、文献与 RAG。
- **优先补正确性与安全**：凭据隔离、桌面信任边界、事件格式兼容，比新增功能更重要。
- **优先补长会话体验**：虚拟化、工作状态、统一 Inspector。
- **不为了“对齐参考项目”而引入第二套运行时**：Fathom 已用 pi SDK 作内核，不要再复制 pi 的 Context 装配或 Agent 循环。
- **不做 CLI/TUI**：Fathom 是图形工作台，不提供终端产品形态。

## 1. 已落地（不再排期）

| 事项                               | 证据                                                                                                                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **并行工具执行**                   | `pi/tools.ts` 的 `executionModeForTool` + `PARALLEL_SAFE_TOOLS`：16 个只读工具并行，写/命令/审批/子 Agent/工作流类保持串行；`pi-engine.test.ts`                                                                                            |
| **`agent_before_settle` 续轮边界** | `pi/auto-follow-up.ts` 的 `createAutoFollowUpExtension`，续轮不再靠 `message_end` 注入隐藏消息；`auto-follow-up.test.ts`。触发方式见 §2                                                                                                    |
| **压缩/重试真实字段**              | `pi/event-bridge.ts` 映射 `tokensBefore`、`estimatedTokensAfter`、`firstKeptEntryId` 与 `compactionStats.replacedMessages`；`pi-event-bridge.test.ts`                                                                                      |
| **后台命令加固**                   | `services/background-command-service.ts` 的 `commandEnvironment`（环境变量白名单）与 `killProcessTree`，配合并发上限与环形缓冲；`background-command-service.test.ts`                                                                       |
| **跨 Agent 写锁与内容校验**        | `pi/workspace-write-coordinator.ts`：同 realpath 串行、写入前比对观察内容、冲突抛 `WORKSPACE_CHANGED`；主 Agent 与子 Agent 共享同一实例（`session-engine`、`sub-agent-orchestrator`）；`workspace-write-coordinator.test.ts`               |
| **已结束会话恢复工具卡**           | `services/session-projections.ts` 直接产出 `tools` 投影，`chat-store.hydrate` 消费 `snapshot.tools`；`session-projections.test.ts`、`chat-store.test.ts`                                                                                   |
| **Trace 泳道 + Request 详情**      | `services/trace-service.ts`、`features/trace/`：输入/模型/工具三泳道、请求圆点、审批/压缩标记、子 Agent 泳道、请求概要页签；`usage-trace.test.ts`                                                                                          |
| **纸感 UI 层**                     | `styles/maison.css`、`components/PaperFrame.tsx`、Electron 窗口配色、字体本地化                                                                                                                                                            |
| **凭据隔离**                       | `services/provider-credential-store.ts`：API Key 落到 `data/credentials.json`（原子写 + 0600），旧 `model_api_key:*` 启动时迁移并删除；`apiKeySource` 改为 `credentials`；`provider-credential-store.test.ts`、`provider-settings.test.ts` |
| **桌面信任边界**                   | `runtime.ts` 的 `decideLink`：只有 daemon origin 留在应用内，其余 http(s) 交系统浏览器，其他 scheme 一律拒绝；桌面每次启动生成 token，`/__desktop/shutdown` 用 `timingSafeEqual` 校验；`runtime.test.ts`、`desktop-token.test.ts`          |
| **SSE / JSONL 加固**               | `services/event-cursor.ts` 支持 `Last-Event-ID`；transient 重放缓冲 512 → 2048；无法解析的 JSONL 行写入 `.corrupt.jsonl` 而不是只打 warning；`event-cursor.test.ts`、`event-store.test.ts`                                                 |
| **JSONL schema 版本**              | `storage/event-store.ts` 的新文件带 `session.header` 版本头，旧文件按版本 1 回放，更新版本只告警；`event-store.test.ts`                                                                                                                    |
| **请求快照增量**                   | `services/request-snapshot.ts` 在 System Prompt / 工具定义未变化时只写标记，长文本保留首尾；`request-snapshot.test.ts`                                                                                                                     |

> **pi 的批量语义（验收时别误判）**：`agent-loop` 的规则是“一批工具调用里只要有一个 `sequential`，**整批**都串行”，不是只串行那一个。因此一条消息里同时出现 `read_file` 与 `write_file` 时，读也拿不到并发。要真正的读写分离并发只能靠分批，不能靠工具标记。

## 2. 唯一未决的设计问题：续轮由谁触发

边界已经换成 `agent_before_settle`，但**模型仍必须输出 `<!-- FATHOM_CONTINUE -->`**（`pi/auto-follow-up.ts` 的 `AUTO_FOLLOW_UP_MARKER` 与 `requestsAutoFollowUp`）。原验收写的「模型不再需要输出隐藏标记」并没有达成——这不是没做完，而是这件事本身是个产品决策：

- **A（推荐）：保留标记作为模型自述信号。** 改验收为「每次续轮写入可审计事件、上限可配置、终止原因可查询」。标记只是“还要不要下一轮”的表达，执行与计数都在我们手里，模型无法绕过上限。
- **B：策略侧触发。** 由我们根据 Todo/Plan 未完成度决定续轮，模型完全不感知。收益是不污染输出，代价是要定义“什么算没做完”，且容易在长任务里空转。

选 A 只需把验收对齐到已有实现；选 B 是一次独立改动。

## 3. 第一批：安全与正确性（已完成，证据见 §1）

五项全部落地：凭据隔离、桌面信任边界、SSE/JSONL 加固、JSONL schema 版本、请求快照增量。

与原始设想的差异，记录一下免得后来人照旧文档做：

- **桌面令牌用请求头而不是 HttpOnly Cookie**：Cookie 会被该 origin 下任何页面自动带上，只有主进程能设的请求头才是更强的边界。
- **`/__desktop/shutdown` 是新增的**，原先并不存在；它同时给了桌面端一条优雅退出的路径，重启前不必再直接 `taskkill`。
- **未做 Electron `safeStorage`**：daemon 是独立进程，拿不到 `safeStorage`；改为独立凭据文件（0600 尽力设置），并保留「文件不在 SQLite 里」这个核心不变式。

## 4. 第二批：长会话体验

| 事项                             | 动作                                                                                                                                                                                                                                                                           | 验收 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| **长会话跟随与未读**（已完成）   | `features/chat/follow-bottom.ts` 的 `isNearBottom`：只有贴近底部才自动跟随，用户上翻时改为累计新消息并显示「回到底部」；侧栏运行 Spinner 已存在（`Sidebar.tsx`）；`follow-bottom.test.ts`                                                                                      |
| **长会话窗口化**                 | 按 Turn 折叠旧工具/思考 + 窗口化渲染。`slice(-visibleLimit)` 已经让 DOM 有界（80 条），所以这里的目标不是「防崩溃」而是降低单帧渲染成本；真虚拟列表要测量高度，收益与风险还需权衡，暂缓                                                                                        |
| **Plans + Todos 胶囊**（已完成） | `components/WorkCapsule.tsx`：一条折叠胶囊同时显示 Todo 完成数/总数、是否有计划、当前步骤，展开看完整清单；`summarizeWork` 负责取值规则，`work-summary.test.ts` 覆盖                                                                                                           |
| **统一 Inspector**（已完成）     | `components/Inspector.tsx`：文件树、文件变更、子 Agent 三个页签收在一个可拖宽的浮层里；`clampInspectorWidth` 保证主区域最小宽度，窗口变窄先压缩侧栏；删掉了独立 `WorkspaceDrawer` 和「文件」视图页签；`inspector-width.test.ts`。**未做**：移动端 sheet、子 Agent 详情分页读取 |
| **本地路径识别**（文件已完成）   | `components/local-path.ts` 的 `parseLocalPathRef` 只认行内代码里的绝对/带扩展名路径，渲染成带完整路径 Tooltip 的胶囊，绝对路径可直接在系统里打开；`local-path.test.ts`。**图片缩略图未做**：需要一个校验工作区边界的受控 media 接口，属于后端安全改动，单独排期                |
| **自动标题**（已完成）           | `services/session-title.ts`：模型生成标题，不阻塞首轮响应；清洗失败、出错或用户已改名时都保留首条输入的 40 字回退；`session-title.test.ts`                                                                                                                                     |

## 5. 第三批：记忆与检索

| 事项                     | 动作                                                                                                                                                              | 验收                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **RAG 评测集（先做）**   | 为文献/记忆召回建固定查询集与指标（Recall@k、MRR）                                                                                                                | 有基线数字，后续每次改检索都能对比       |
| **本地语义记忆（后做）** | 接入 `multilingual-e5-small`（q8 ONNX、首次下载缓存、失败回退 FTS）；补 user/workspace scope、来源 Session、revision 冲突；复用同一 embedder 给未来的 tool_search | 评测集上的 Recall@k 高于当前哈希向量基线 |

顺序不能反：先换 embedder 再建评测集，等于没有基线。

## 6. 第四批：平台化（按需）

| 事项                | 动作                                                                                                                                                                        | 验收                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **结构化工具结果**  | `ToolResult` 补 `structuredContent`、`annotations`（`readOnly`/`destructive`/`idempotent`）、长任务 `onUpdate` 进度；UI 与策略共用，不再把全部内容塞进文本 details          | 至少一个工具端到端用上，UI 与策略读取同一字段 |
| **Skills 规范对齐** | 支持标准 `SKILL.md` 的 `allowed-tools`、`license`、`compatibility`；保留 Run 预授权 + 内容指纹复查；发现规则对齐 pi 的 `.agents/skills`（**不是 `.claude/skills`**，见 §9） | 现有 skill 行为不回退                         |
| **分层重构**        | `server.ts` 仍约 1290 行；新域（MCP、插件、评测）继续按 `routes/*` 拆分，响应 schema 与 DTO/VO 显式脱敏                                                                     | 拆分前后路由快照一致；先量化再动              |
| **样式拆分**        | `styles.css` 仍约 9550 行；`styles/maison.css` 作为设计层，后续按 chat / settings / trace / board 拆组件级样式                                                              | 拆分前后首屏 CSS 体积有对比                   |
| **设置目录化**      | 从锚点长页改为「左侧目录 + 右侧 720px 内容」                                                                                                                                | 窄屏折叠为单列                                |

## 7. 后置（等里程碑决定，不排期）

| 事项                                         | 触发条件                                                                                        | 第一版范围                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **MCP 最小 Host + tool_search**              | `AGENTS.md` 规定 M1–M4 不实现 MCP；等里程碑解禁后再接                                           | 只做 stdio + Streamable HTTP；配置/凭据/信任分离；工具级启停与稳定别名；不做 Resources/Prompts/Elicitation/Sampling，也不追新协议版本 |
| **Session tree / 分支摘要 / `context_edit`** | 已有 fork、分支树、对比与三方合并，差在“放弃分支摘要”和“只改模型上下文、不改审计历史”的编辑语义 | 会同时影响事件投影与测试，越晚做改动成本越高                                                                                          |
| **Durable 语义**                             | 只借 `requestId` 幂等、任务 phase checkpoint、`restartLimit` 熔断                               | 不整体迁移到 pi 的 Experimental 运行时                                                                                                |

## 8. 明确不做

| 方向                                             | 原因                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| **CLI / TUI / 终端产品形态**                     | Fathom 是本地图形工作台；不做 CLI 入口、交互式 PTY 或 TUI 渲染。                                                         |
| **完整插件市场 + 插件级 OAuth Gateway**          | pi-harness 的价值建立在大量内容与凭据/生命周期设施上；直接搬会引入巨大安全面与维护量。只借 manifest 形状或文档类 Skill。 |
| **Computer Use**                                 | macOS 原生 helper、辅助功能/屏幕录制权限、稳定签名、脚本运行时；除非产品核心变成桌面操作，否则不做。                     |
| **Tauri 重写**                                   | 已有 Electron、sidecar、数据/缓存目录迁移与安装包；只借 bootstrap token、HTTPS-only 外链、发布/签名流程。                |
| **GitHub 登录 / 多用户认证**                     | Fathom 是单用户本地应用；多用户认证扩大攻击面且无收益。                                                                  |
| **Codemode / QuickJS 工具脚本**                  | pi 用 QuickJS(wasm) 跑模型写的脚本；会引入工具暴露、沙箱资源、脚本审计等复杂度，工作流/DAG 已覆盖主要编排需求。          |
| **复刻 pi 的 System Prompt 分段装配 + 压缩重放** | 会与现有 pi 压缩 + 确定性 checkpoint 双重执行；只借快照增量与固定投影边界。                                              |
| **pi-harness 的子 Agent 硬限制**                 | 每个 Agent 3 个直接子任务、2 层嵌套、30 分钟是参考项目的取舍；Fathom 的 DAG 与预算更灵活，不回退。                       |
| **pi-harness 的任务看板状态推进**                | 它按「最后收到的相关事件」更新，两个子任务同时等审批时会丢状态；Fathom 已有聚合。只借 HITL 等待归约与 Plan 进度。        |
| **HeroUI 视觉身份**                              | 保留 Fathom 的纸感主题；只借布局、语义色、交互结构。                                                                     |
| **富内容块协议（chart / flow）**                 | 已有 KaTeX 与 Mermaid 覆盖主要需求；chart/flow 需要严格 schema 与额外渲染库，对本地工作台收益低。                        |
| **自建模型目录缓存**                             | pi 的 `ModelRuntime` 已内置 ETag/Last-Modified 增量与失败保留旧快照，我们已经在用（`pi/model.ts`），无需自建。           |

## 9. 本轮核对更正的参考项目事实

原清单有几处归错了主体或引用了并不存在的行为，后续不要再沿用：

| 原表述                                       | 更正                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 「pi 的子 Agent 硬限制 3/2/30」              | pi-main 明确不内置子 Agent 与 plan mode（见其 README）；3 个直接子任务 / 2 层 / 30 分钟是 **pi-harness-main** 的取值。                           |
| 「pi 的任务看板状态机」                      | pi-main 没有任务看板；「最后收到的事件覆盖状态」出自 pi-harness-main 的看板设计。                                                                |
| 「补 `.claude/skills` / `~/.claude/skills`」 | pi 现行代码发现的是 `~/.pi/agent/skills`、`.pi/skills`、`~/.agents/skills`、`.agents/skills`，没有 `.claude/skills`。目标改为 `.agents/skills`。 |
| 「每个后台 Session 一条 SSE」                | pi-harness 也只给当前可见会话开 SSE（外加子 Agent 详情一条），与 Fathom 取舍相同，不构成反面案例。                                               |
| 「pi 的 Context Pipeline」                   | pi 没有这个命名的组件；最接近的是 System Prompt 分段装配与 `compaction`。                                                                        |
| 「模型目录缓存需要自建」                     | pi 的 `ModelRuntime` 已提供，见 §8。                                                                                                             |

## 10. 工程要求

每个条目完成时至少运行：

```bash
pnpm typecheck && pnpm test && pnpm check
# 改动 UI 或构建配置时
pnpm build
```

- 新增持久化、取消、并发路径必须有测试。
- 涉及事件字段的改动必须同时更新回放兼容性（见 §3 的 schema 版本）。
- 现有单元/集成 + 浏览器 + Electron E2E 的覆盖基线继续保持，不做只跑通 happy path 的改动。
- 文档里的数字（测试数、文件行数）不写死，或标注核对日期。

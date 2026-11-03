# 路线图

> 与 `pi-harness-main` 的功能对齐已经拆成可逐项勾选的清单：
> [implementation-checklist.md](./implementation-checklist.md)。本文件保留阶段背景与规模估算。

## 1. 规模预期

参考项目 `pi-harness-main` 大约：

- 后端（daemon + packages）约 3.5 万行 TS；
- Web 约 3.4 万行 TS/TSX；
- 另有桌面壳、Computer Use 原生 helper、插件与 Skill 文档。

本项目的策略不是追求同等行数，而是**同等能力 + 更清晰的内核**：

| 阶段                     | 预计规模  | 说明                                 |
| ------------------------ | --------- | ------------------------------------ |
| M0–M1（当前）            | ~6–8k 行  | 可运行的对话/工具/审批/事件/文献切片 |
| M2 上下文与编辑体验      | +4–6k     | 压缩、计划、队列、附件、分支、diff   |
| M3 记忆与 RAG            | +5–8k     | 文档入库、混合检索、引用、画像       |
| M4 多 Agent 编排         | +8–12k    | 子 Agent 树、任务看板、DAG/工作流    |
| M5 桌面与 Computer Use   | +8–12k    | Electron、sidecar、权限、原生 helper |
| 达到“参考项目同等功能面” | 约 30–45k | 不含大型 UI 组件库与插件内容         |
| 加上自研工作流/文献生态  | 约 50–70k | 取决于插件、文档与 UI 深度           |

单人全职的粗略节奏：M2 约 2–3 周，M3 约 3–4 周，M4 约 4–6 周，M5 约 4–6 周；
再加测试、打包与打磨，**16–24 周**可以到“功能面接近、但更可控”的状态。

## 2. M0–M1：可运行骨架（已完成）

**目标**：一条真实可用的最小闭环。

已交付：

- 自建 Agent 循环（文本流、tool_use、tool_result、取消、最大步数）。
- Anthropic + Mock 两个 ModelClient。
- 工具：list/read/search/write/edit/command；路径策略与审批。
- JSONL 事件源 + SQLite 索引；SSE 快照/回放/增量；断线重连去重。
- Web：会话列表、流式对话、工具卡片、审批卡、停止、审批模式切换。
- 文献：PDF 上传/逐页抽取/结构化分析（摘要、知识清单、技术路线、创新点、实验、局限、页码引用）。
- 测试：路径策略、事件存储、Agent 循环；`typecheck`、`build`、`check` 通过。

验收标准：

- 不配置 API Key 也能跑通 Mock 对话 + 工具 + 审批。
- 配置真实 Key 后可直接对话。
- 重启 daemon 后会话消息仍可恢复。
- 审批拒绝后工具不执行，模型收到错误结果并继续。

## 3. M2：上下文与编辑体验（进行中，已迁移 pi 内核）

**目标**：从“能聊”到“能长时间工作”。执行内核已切换到 pi SDK；以下标记为已完成的项由 pi 提供或已接线。

- ✅ **上下文压缩**：由 pi SDK 自动执行，daemon 投影事件；手动压缩入口已接；压缩时生成结构化检查点、版本链，并支持双版本对比与空闲恢复。
- ✅ **Context 审计与编辑**：`search_history` 历史检索、请求级快照、显式标记驱动的有界自动续轮、历史消息改写分支、文件变更整体撤销/重放。
- ✅ **工具与沙箱**：web_fetch/web_search/view_image/read_document/view_pdf_page、后台命令等待、工具守卫、沙箱 Profile/域名边界与宿主重跑审批。
- ✅ **Skills**：SKILL.md 注册表、scope 覆盖/禁用、按需加载工具、系统提示目录、设置页、GitHub 安装与 Composer `$skill`；插件 manifest/市场/OAuth 仍待实现。
- ✅ **用量与 Trace**：用量聚合/热力图/趋势/费用估算与 Trace 时间线/请求快照/子 Agent 切换已完成；输入/模型/工具三泳道、请求概要页签与子 Agent 泳道已补；父 Tool 跳转子轨迹与多 Run E2E 仍待补。
- ✅ **对话体验**：对话/轨迹/文件三视图、轮次导航、消息复制/编辑重发/重试/fork、思考面板、工具结果按需加载、文件 Inspector。
- ✅ **沙箱与持久**：SRT 包装 `run_command` 与凭据环境变量脱敏；Session FTS5、Durable 手动续跑、可配置语义 Embedding。
- ✅ **Todos**：`update_todos` 工具 + 事件 + Web 面板。
- ✅ **消息排队**：运行中 follow-up 队列 + 排队项删除 + Web 排队条。
- ✅ **转向（steer）**：`POST /api/sessions/:id/steer` 接入 pi `steer()`，Web 运行中发送即可插话。
- ✅ **Plan 模式**：只读 prompt、副作用工具硬阻断、结构化 `plan.created`、计划卡、显式批准后自动执行、自然语言修改并生成下一版计划。
- ✅ **聊天附件**：图片最多 4 张；PDF/DOCX/PPTX/XLSX/文本抽取、隐藏上下文注入、附件条。
- ✅ **Diff / 文件变更**：write/edit 事件 + Web diff 查看器；撤销/重放待做。
- ✅ **命令进程管理**：后台命令启动、列表、输出、停止、进程树回收，daemon 关闭时统一清理。不做交互式终端。
- ✅ **Session fork**：复制当前 pi 历史与 JSONL，或按历史用户消息 cutoff 派生分支；记录父会话并展示“分支自”；收口未决审批。✅ 分支树导航、差异对比、摘要合并、事件快照的三方代码合并。
- ✅ **重试**：pi 自动重试事件投影；错误分类展示待细化。
- **测试**：压缩、队列、分支、命令回收、审批取消配对。

## 4. M3：长期记忆与 RAG（FTS baseline 已完成）

**目标**：让 Agent 记住用户与工作区，并能在文档里找依据。

已完成的第一层（写在 daemon 内，未单独拆包）：

- 文献上传自动切块入库：`knowledge_documents / knowledge_chunks / knowledge_chunks_fts`；
- FTS5 trigram 检索（短查询走 LIKE），`search_knowledge` 只读工具；
- 文献页顶部的知识库搜索与页码跳转；
- 测试覆盖索引/替换/删除/中英文检索/工具格式化。

长期记忆（基线已完成）：

- ✅ 复用 `knowledge_documents(kind='memory')` 存储文本记忆，无需新增表。
- ✅ FTS/BM25 + 本地字符 n-gram 哈希向量，RRF 融合召回；Embedder 是端口，后续可替换语义模型。
- ✅ `save_memory` / `search_memory` / `forget_memory` 工具（写操作审批）与独立记忆页。
- ⬜ user/workspace scope、去重与 revision 冲突、用户画像派生。
- ✅ 请求级 context 自动注入：记忆前缀进入模型上下文，但用户可见消息保持干净，并显示“已注入 N 条记忆”。
- ⬜ 更细的记忆引用卡片与来源跳转。
- ⬜ 语义 embedding、评测集、workspace 文档入库。

**文献模块升级（M3 已完成第一批）**：

- ✅ 长文 map-reduce：按页/章节切块，片段抽取 → 汇总；保留来源页。
- ✅ 章节识别与章节结构展示。
- ✅ 引用校验：页码范围、evidence 原文匹配、confidence/citationStatus。
- ✅ 进度阶段与取消。
- ⬜ 图表/表格提取：图注、表格文本、页面截图。
- ⬜ 跨文献综述：多篇文献对比、研究脉络、方法/数据集矩阵。
- ✅ 导出：Markdown / JSON / BibTeX 元数据。

## 5. M4：多 Agent 编排与工作流（最小闭环已完成）

**目标**：从单 Agent 变成可观察、可预算、可恢复的执行树。

已完成的最小闭环（含看板/DAG）：

- `spawn_agent` / `wait_agents` / `send_agent` / `stop_agent` 控制工具；
- 平级子 Agent（最多 3 并发、8 个/轮、10 分钟/个），explorer/reviewer 只读、worker 可写；
- 子 Agent 独立 pi AgentSession/上下文，事件带 executionId，审批可标识来源；
- `run_workflow` 提交 DAG，按依赖自动调度，失败向下游传播；
- Web 子 Agent 三视图：看板 + 依赖图（拓扑层/连线）+ 列表详情；
- 用户自建顶层任务看板：待开始/执行中/需处理/待确认/已完成，任务→Session/Run，状态由审批、Todo、文件变更与 Run 终态派生；
- 父 Run 结束时中止未完成的子 Agent，避免泄漏。

后续：
- **编排模式**：
  - 并行 fan-out / fan-in；
  - 串行 DAG；
  - 路由（按能力/成本选模型）；
  - 评审者模式（worker + reviewer）。
- **工作流触发器**：✅ 手动、cron + 时区、Webhook、文件变更、条件匹配；⬜ 复杂条件表达式与多条件组合。
- **可靠性**：中止传播、收尾等待、事件归属、重启恢复、幂等去重。
- ✅ **UI**：工作流可视化编辑器、保存/复用/最近运行、工作区文件树/文本编辑已实现；⬜ 全局任务筛选/拖拽排序、执行树、预算与用量、失败重试。
- **测试**：中止窗口、预算、并发槽位、终态事件配对、恢复、任务看板状态机。

## 6. M5：桌面端与 Computer Use

**目标**：从浏览器工作台变成可分发的本地应用。

- **Electron 客户端（基线已完成）**：
  - ✅ 动态回环端口、daemon sidecar、健康检查、优雅关闭；
  - ✅ 隐藏标题栏 + 集成状态栏、浅色清新主题、esbuild 打包 daemon；
  - ⬜ 随机 token/Cookie 隔离、自动更新、崩溃日志。
- **Computer Use（macOS 优先）**：
  - 原生 helper：窗口截图、Accessibility Tree、点击/输入/滚动；
  - 系统权限（辅助功能/屏幕录制）+ 应用白名单；
  - 受限 JavaScript 脚本运行时，所有动作逐次审批；
  - 非 macOS 平台先不做系统级操作。
- **安全**：桌面 token 只用于本机隔离；不要把它当成多用户认证。
- **打包**：签名、公证、自动更新、崩溃日志（可选）。

## 7. 明确后置：MCP

按当前决定，**M1–M4 不实现 MCP**。

未来接入时的边界（不改变现有架构）：

- 独立 `packages/mcp`：Client/transport/catalog；
- daemon 负责服务器配置、凭据、信任、连接生命周期；
- 工具注册器把 MCP 工具当作外部工具注入，仍走 Policy + 审批 + 事件；
- 先支持 stdio + Streamable HTTP，再考虑 OAuth/资源/提示词；
- 不把 MCP 能力耦合进 Agent 循环或 Web 协议。

## 8. 贯穿所有阶段的工程要求

- 每个里程碑：`pnpm typecheck`、`pnpm test`、`pnpm check`、`pnpm build` 全绿。
- 新增持久化/取消/并发路径必须有针对性测试；不做“只测 happy path”。
- 新增外部输入（文件、URL、命令、模型输出）必须能指出信任边界与校验位置。
- 不引入未审查的本地运行时/原生依赖；桌面 helper 单独做权限审计。
- 文档与实现同步更新；已知限制写进 README，而不是留在聊天记录里。

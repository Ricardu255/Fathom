# Fathom 功能对齐与实施清单

> 参考基线：`D:\code\TypeScript\pi-harness-main`  
> 目标：逐项对齐参考项目的客户端体验与平台能力，同时保留 Fathom 已有的工作流、文献、Git 与分支合并能力。  
> 状态：`[x]` 已完成；`[ ]` 未完成；`[ ] ◐` 部分完成。  
> 规则：一个条目应能独立验收；完成代码、测试、文档后才勾选。每批结束运行 `typecheck`、`check`、单元测试、浏览器 E2E 与桌面 E2E。

## 0. 已完成基线

### 0.1 Runtime 与协议

- [x] pi SDK 执行内核：Session、工具循环、压缩、重试、follow-up 队列、steering。
- [x] 事件 JSONL 事实源、SQLite 索引、SSE 快照/回放/增量、断线重连。
- [x] 工具：`list_files`、`read_file`、`search_text`、`write_file`、`edit_file`、`run_command`。
- [x] 逐次审批 / 自动批准、多审批槽位、计划模式、Todos、队列、停止 Run。
- [x] 文档附件：PDF、DOCX、PPTX、XLSX、文本；图片消息；`@` 工作区文件引用。
- [x] 子 Agent：spawn / wait / send / stop，DAG 调度、预算、重启补偿。
- [x] 工作流：编辑、保存、cron/时区、Webhook、文件变更触发、运行历史。
- [x] 长期记忆：CRUD、FTS + 本地哈希向量 RRF、请求级自动注入。
- [x] 文献解析：章节识别、长文 map-reduce、引用校验、进度/取消、Markdown/JSON/BibTeX 导出。
- [x] 会话：搜索、重命名、归档恢复、历史 fork、分支树、对比、摘要合并、三方代码合并。
- [x] Git 面板、后台命令、工作区文件树与文本编辑。
- [x] 独立设置页：主题、审批模式、Provider/模型/API Key。
- [x] Electron 客户端、动态端口、daemon sidecar、集成状态栏、安装包。
- [x] 测试基线：252 项单元/集成、42 项浏览器 E2E、1 项 Electron E2E。

### 0.2 不重复实现

以下条目已完成，后续实现新功能时不得回退：

- [x] 不重新引入 Mock UI、Mock 徽标或 Mock 文案。
- [x] 不把 API Key 回显到 UI、接口响应、日志或错误消息。
- [x] 不把完整 Session 历史复制进 SQLite 事实表；JSONL 仍是事实源。
- [x] 不为了新功能绕过现有 Policy、审批、事件和 SSE 契约。
- [x] 不修改参考项目 `pi-harness-main`。

---

## 1. P0：第一屏与客户端外壳

### 1.1 Hero 首页

- [x] **H-01 Hero 首页骨架**：把 `/` 从品牌欢迎页改为 720px 居中 Hero 输入页。
  - 验收：刷新首页不创建空 Session；发送第一条消息后才创建；URL 与侧栏导航正确。
- [x] **H-02 Hero Composer 复用**：复用现有 Composer，增加 `hero` 展示模式。
  - 包含：输入、图片、待上传文档、发送/停止、运行中排队、Plan 开关。
  - 验收：首页与已进入会话的 Composer 行为一致；E2E 覆盖。
- [x] **H-02a Hero 工作区选择**：首页 Composer 上方选择/添加 Workspace；不可用 Workspace 禁用发送。
  - 依赖：W-01、W-02、W-03。
- [x] **H-02b Hero 模型选择**：首页 Composer 上方选择 Provider/Model/推理强度。
  - 依赖：C-01、C-02、C-03。
- [x] **H-02c Hero 审批选择**：首页 Composer 上方切换审批策略，并写入全局设置。
  - 依赖：AP-01。
- [x] **H-03 快捷提示**：写作、编程、研究、创意四个快捷键，点击后填入提示词但不自动发送。
- [x] **H-04 首页标题区**：`Hi` / `我们从哪里开始？`，无登录系统时不展示用户名。
- [x] **H-05 首页 Navbar**：新对话页面标题“新对话 / 开始一段全新的对话”；保留现有集成状态栏。
- [x] **H-06 首页搜索入口**：Navbar 搜索按钮与 `⌘/Ctrl K` 命令面板一致。
- [ ] ◐ **H-07 首页空态/加载态/错误态**：模型未配置、发送失败、附件上传失败已有反馈；工作区不可用已禁用发送，原因提示待补。
- [x] **H-08 移动端布局**：Hero Composer、侧栏与弹层在窄屏可用。
- [x] **H-09 首页 E2E**：首页发送、快捷提示、文档附件、刷新不创建 Session、窄屏布局。

### 1.2 侧栏结构

- [ ] **H-10 侧栏一级导航**：新对话、任务中心，保留文献、记忆、工作流等 Fathom 扩展入口。
- [x] **H-11 工作区分组**：Workspace 作为一级节点，下面挂对话。
  - 依赖：W-01、W-02、W-06。
- [ ] ◐ **H-12 对话运行/未读提示**：运行中 Spinner 已接入 `isRunning`；未读点尚未实现。
- [x] **H-13 会话折叠**：每个 Workspace 默认显示 5 条，支持展开/折叠。
- [x] **H-14 对话操作**：重命名、归档、恢复；与现有分支树入口不冲突。
- [x] **H-15 侧栏状态记忆**：折叠状态保存在 `localStorage`，不写入服务端事实。

---

## 2. P0：Workspace 管理

- [x] **W-01 Workspace 数据模型**：`workspaces` 表：`id`、`root_path`、`display_name`、`sort_order`、`removed_at`、时间戳；显式 migration 13。
- [x] **W-02 WorkspaceService**：真实路径校验、目录存在性、去重、软移除、恢复、可用性检查。
- [x] **W-03 Workspace API**：列表、添加、重命名、排序、软移除、目录选择。
- [x] **W-04 原生目录选择器**：Electron preload/IPC 打开系统目录选择；Web 开发环境提供降级入口。
- [x] **W-05 Session 绑定 Workspace**：创建 Session 使用 `workspaceId`，创建后不可变更；兼容旧 `workspaceRoot` 数据。
- [x] **W-06 侧栏工作区列表**：新增、展开、收起、按 Workspace 分组的会话。
- [x] **W-07 工作区操作菜单**：重命名、在文件管理器中显示、移除项目。
- [x] **W-08 工作区排序**：拖拽排序 + `Alt+↑/↓` 键盘排序；顺序持久化。
- [x] **W-09 不可用工作区**：目录缺失/不可访问时标记、禁用新建对话并显示原因。
- [x] **W-10 旧数据迁移**：现有 `workspace_root` 回填工作区，缺少 `workspace_id` 的会话启动时补齐。
- [x] **W-11 Workspace 测试**：真实路径、软移除、重加恢复、排序原子性、越界拒绝、API 与侧栏 E2E。

---

## 3. P0：Composer 与模型选择

- [x] **C-01 Provider/模型目录 API**：返回 Provider、模型名、上下文窗口、最大输出、推理档位、配置状态；不回传密钥。
- [x] **C-02 Model Picker**：Provider 分组、模型搜索、当前模型、未配置提示、推理强度。
- [x] **C-03 默认模型设置**：全局默认 Provider/Model/推理档位；新会话复制默认值。
- [x] **C-04 会话模型字段**：Session 保存 `provider_id`、`model_id`、`thinking_level`；新 Run 使用当前值，活动 Run 禁止切换。
- [x] **C-05 会话内模型切换**：首页与会话页接入 ModelPicker；切换只影响后续 Run。
- [x] **C-06 推理强度**：按模型能力展示 off/minimal/low/medium/high/xhigh/max 子集。
- [x] **C-07 Context Usage Popover**：当前上下文占用、窗口大小、压缩次数、最近请求用量。
- [ ] **C-08 输出详细度/推理摘要**：当前 pi `AgentSession` 不暴露 provider-neutral verbosity/reasoning summary；等 SDK 提供统一请求选项或增加 Provider 特定适配后再接。
- [x] **C-09 连接测试**：`POST /api/models/test` 使用最小请求测试已配置/草稿 Key，不持久化消息；设置页展示延迟与错误。
- [x] **C-10 自定义 Provider**：OpenAI-compatible / Anthropic-compatible 端点、Base URL、模型列表、独立 API Key；设置页管理与 ModelPicker 自动合并。
- [ ] ◐ **C-11 Provider OAuth**：OAuth Provider 列表、启动、事件/设备码/授权链接、交互 prompt、取消、登出已接入 pi CredentialStore；真实 Provider 授权流程尚未在联网环境验收，刷新由 pi 托管。
- [ ] ◐ **C-12 模型设置测试**：目录元数据、会话切换、连接测试错误、密钥脱敏已覆盖；能力裁剪与真实 Provider 连接成功路径待补。

---

## 4. P1：审批与 Human-in-the-loop

- [x] **AP-01 三档审批策略**：`request_approval` / `auto_approve` / `full_access`，设置页、首页与会话页共用。
- [ ] ◐ **AP-02 AI 审批复核**：`auto_approve` 下 pi 引擎对 `run_command` / `start_background_command` 调用独立模型复核，只有明确 allow 才自动执行，其他情况转人工；MCP 与 builtin 引擎待接。
- [x] **AP-03 审批卡增强**：显示风险等级、规范化目标、影响说明，参数默认折叠；多个待审批操作继续按栈展示。
- [x] **AP-04 命令前缀授权**：仅对无 Shell 组合符的安全命令生成 token 前缀；审批卡“允许类似命令”写入 SQLite 允许列表，执行前重新校验，设置页可撤销。
- [x] **AP-05 会话级授权**：非 Shell 工具可“本次会话允许”，按工具名 + 目标记忆，跨 Run 保留到 daemon 重启或引擎关闭。
- [x] **AP-06 Human Input 协议**：`input.requested` / `input.resolved` / `input.expired` 事件与 daemon 服务。
- [x] **AP-07 `request_user_input` 工具**：问题、选项、单选/多选、自由输入、必填校验。
- [x] **AP-08 提问卡片 UI**：分页、单选自动前进、多选停留、最终提交、超时/取消状态。
- [x] **AP-09 计划审阅交互**：完整 Markdown 计划书、确认执行、自然语言修改并生成下一版。
- [x] **AP-10 等待恢复**：超时、Abort、daemon 重启后统一收口；SSE 快照包含未决提问。
- [x] **AP-11 HITL 测试**：并发审批、超时、重启、子 Agent 归属、重复提交冲突。

---

## 5. P1：Context、分支与文件变更

- [x] **X-01 结构化 Checkpoint**：目标、约束、决策、已完成、待完成、阻塞、下一步；写入 `context.compacted`。
- [x] **X-02 Checkpoint 版本链**：稳定版本 ID、上一版本、覆盖消息范围、触发原因。
- [x] **X-03 Checkpoint 对比/恢复**：Web 双版本对比；Session 空闲时恢复并追加恢复事件。
- [x] **X-04 工作状态重置**：每个新顶层 Run 清理上一 Run 的 Plan/Todos 工作状态，原始事件保留。
- [x] **X-05 Session 历史搜索工具**：从完整 JSONL 检索有界片段，返回消息序号。
- [x] **X-06 自动续轮**：无工具任务跨模型轮次有界自动继续；内部消息不渲染。
- [x] **X-07 请求级 Context 快照**：每次模型请求记录 System Prompt、工具定义、消息数组和估算用量。
- [x] **X-08 消息改写/重试分支**：从指定用户消息创建改写分支并重跑；不删除旧分支。
- [x] **X-09 文件变更撤销/重放**：基于 `file.changed` 的 before/after；冲突时整体拒绝。
- [x] **X-10 AGENTS.md 注入**：有界读取 workspace `AGENTS.md`，作为独立 Context 来源。
- [x] **X-11 Context 测试**：压缩边界、恢复、工具调用组不拆分、超窗错误、历史检索。

---

## 6. P1：工具与 OS 沙箱

- [x] **T-01 `web_fetch`**：公开 HTTP(S)、重定向限制、SSRF 防护、私网拒绝、大小/超时/中止。
- [x] **T-02 `web_search`**：本机 SearXNG 或可配置搜索服务；返回标题、URL、摘要。
- [x] **T-03 `view_image`**：workspace 图片校验、模型图片能力判断、尺寸/大小限制。
- [x] **T-04 `read_document`**：复用现有 PDF/DOCX/PPTX/XLSX 解析，作为只读工具暴露。
- [ ] ◐ **T-05 `view_pdf_page`**：已接入 unpdf 指定页渲染与编码大小限制；运行环境需额外安装 `@napi-rs/canvas`，未安装时返回明确错误。
- [x] **T-06 命令等待/停止工具**：`wait_background_command`、`stop_background_command`；与现有 BackgroundCommandService 统一进程身份。
- [ ] ◐ **T-07 Tool Execution Guard**：并发上限、超时、同参数副作用去重已完成；目标状态复查仍依赖各工具的 realpath/原子写校验。
- [x] **T-08 沙箱包与 Profile**：独立 `packages/sandbox`；`read_only` / `workspace_write` 文件与网络边界。
- [x] **T-09 宿主重跑审批**：沙箱明确拒绝后展示原因，用户逐次批准后以宿主权限重跑。
- [ ] ◐ **T-10 沙箱设置**：Profile、域名 allow/deny 与原子替换已完成；凭据注入尚未接入。
- [x] **T-11 工具/沙箱测试**：SSRF、越界路径、超时、进程树回收、沙箱拒绝和宿主重跑。

---

## 7. P1：MCP Host

- [ ] **G-01 MCP 包边界**：独立 `packages/mcp` 或 daemon 模块；契约不依赖 Web。
- [ ] **G-02 stdio transport**：进程启动、握手、消息缓冲、退出与回收。
- [ ] **G-03 Streamable HTTP / SSE transport**：连接、超时、取消、重连边界。
- [ ] **G-04 服务器配置**：CRUD、启用、信任、配置版本；与 Session 解耦。
- [ ] **G-05 凭据存储**：Header/env/OAuth 独立存储、0600、原子写、脱敏。
- [ ] **G-06 能力目录**：工具/资源/提示词发现、缓存、刷新、指纹失效。
- [ ] **G-07 工具注入**：MCP 工具进入现有 ToolRegistry、Policy、审批、事件链。
- [ ] **G-08 `tool_search`**：BM25 + 本地向量 RRF；默认加载 8 个、最多 10 个，不授权。
- [ ] **G-09 MCP OAuth**：发现、PKCE、动态注册、授权窗口、刷新、登出。
- [ ] **G-10 MCP 设置 UI**：服务器列表、详情、表单/JSON、工具级开关、信任。
- [ ] **G-11 Composer MCP 标签**：`+ → MCP` 选择已信任服务器；只作为消息提示，不绕过审批。
- [ ] **G-12 MCP 测试**：stdio/HTTP、401、OAuth、缓存失效、daemon 重启、工具执行失败隔离。

---

## 8. P2：Skills 与插件

- [x] **S-01 Skill Registry**：`SKILL.md` 解析、frontmatter 校验、稳定 ID、大小/路径限制。
- [x] **S-02 Skill 发现优先级**：system → global → project；同名覆盖；禁用后不回退。
- [x] **S-03 Skill 工具**：`find_skill` / `get_skill` / `load_skill` / `skill_creator`；按需读取资源。
- [x] **S-04 System Prompt Skill 目录**：只注入名称与描述，不预载正文。
- [ ] ◐ **S-05 Composer `$skill`**：输入 `$` 选择并插入引用、消息回显、重复引用去重在 daemon 解析时完成；尚未做独立标签 chip。
- [x] **S-06 技能设置页**：系统/全局/项目 Skill、启用状态、正文查看。
- [x] **S-07 Skill 安装**：从受限 GitHub 来源安装到全局目录；超时、输出上限、失败清理。
- [ ] **S-08 插件清单**：`manifest.yaml`、Skill、MCP App、Logo、OAuth 声明。
- [ ] **S-09 插件市场 UI**：安装/卸载、详情、App 与 Skill 状态。
- [ ] **S-10 插件 OAuth Gateway**：只读路径白名单、token 注入、刷新、凭据隔离。
- [ ] **S-11 插件 MCP App**：复用 MCP Client/凭据/能力目录/Policy；不建第二套实现。
- [ ] **S-12 文档插件**：Documents/PDF/Presentations/Spreadsheets 的读取、渲染与生成流程（按需）。
- [ ] ◐ **S-13 Skills/插件测试**：Skills 越界路径、同名覆盖、安装失败、清理已覆盖；插件/OAuth 失败路径待插件实现后补。

---

## 9. P2：Trace 与用量统计

- [x] **U-01 用量聚合**：从 JSONL 读取主 Agent、子 Agent、压缩调用；按 Session lastSeq 缓存增量结果。
- [x] **U-02 用量 API**：近 365 天、Provider、Model、请求数、Token、费用估算。
- [x] **U-03 用量页面**：热力图、请求趋势、Token 趋势、日期/模型筛选。
- [x] **U-04 Trace 投影**：Run、Turn、Request、Tool、Approval、Context、Sub Agent 记录。
- [ ] ◐ **U-05 Trace 页面**：时间线、详情页签、请求快照已完成；独立泳道视图尚未实现。
- [ ] ◐ **U-06 子 Agent Trace**：executionId 切换与子 Agent 消息/工具已完成；父 Tool 一键跳转子轨迹尚未接。
- [ ] ◐ **U-07 用量/Trace E2E**：页面与单 Run 请求快照已覆盖；子 Agent、压缩、失败 Run 的展示由单元投影测试覆盖，尚未全部走浏览器 E2E。

---

## 10. P2：对话与富内容 UI

- [x] **R-01 会话视图切换**：对话 / 轨迹 / 文件。
- [ ] ◐ **R-02 消息操作**：复制、编辑重发、从消息 fork/retry 已完成；“跳转上下文”尚未接。
- [x] **R-03 轮次导航**：会话 Turn 目录，按滚动位置更新。
- [ ] **R-04 长会话性能**：虚拟列表、流式合并、工具增量 100ms 合并、文件摘要缓存。
- [x] **R-05 推理面板**：思考内容折叠、流式状态、结束稳定展示。
- [ ] **R-06 富内容块**：Mermaid、图表、公式、图片生成、网页搜索/抓取结果卡片。
- [x] **R-07 工具详情**：折叠不序列化完整结果；展开按需读取 16k 预览后的完整事件。
- [x] **R-08 文件 Inspector**：扩展名图标、目录树、预览、系统应用打开。
- [ ] **R-09 会话搜索定位**：命中消息后跳转并短暂高亮关键词。
- [ ] **R-10 会话状态**：运行中、未读、归档、错误状态在侧栏与页面一致。
- [ ] **R-11 可访问性与窄屏**：键盘导航、焦点、移动端抽屉、减少动态效果。

---

## 11. P3：平台与桌面增强

- [ ] **P-01 Computer Use helper**：macOS 原生窗口截图、Accessibility Tree、点击/输入/滚动（按平台评估）。
- [ ] **P-02 Computer Use 权限**：辅助功能/屏幕录制权限、应用白名单、撤销与状态刷新。
- [ ] **P-03 Computer Use 脚本**：受限 JavaScript `cua` API、动作计数、超时、观察过期校验。
- [ ] **P-04 桌面安全隔离**：bootstrap token / Cookie、外部 URL `noopener`、协议限制。
- [ ] **P-05 桌面发布**：签名、公证/安装包校验（按目标平台）、崩溃日志、自动更新（可选）。
- [ ] **P-06 本地登录（可选）**：GitHub OAuth / Device Flow；如果坚持单用户可明确后置。
- [ ] **P-07 Context Evals**：确定性压缩/恢复评估与显式真实 Provider 入口。
- [ ] **P-08 外部文件打开**：本地路径点击、应用选择、权限边界。
- [ ] **P-09 Rust/Tauri 客户端体积 PoC（可选）**：保留现有 Web 与 Node daemon，只替换 Electron 壳；测量安装包、启动时间、WebView2 兼容性与更新链路。决策门槛：安装包显著低于 Electron 版本且不牺牲现有桌面能力；不重写 Agent 内核。
- [x] **P-10 自定义安装位置**：NSIS 改为非 one-click，允许用户选择安装目录；保留桌面与开始菜单快捷方式。
- [x] **P-11 自定义数据/缓存目录**：设置页选择数据目录与缓存目录；桌面端持久化到固定 `userData/storage.json`。数据目录支持下次启动迁移复制，缓存目录只切换不迁移；迁移失败回退旧目录；重启前等待 daemon 退出。

---

## 12. Fathom 额外能力后续增强（非参考项目必需）

- [ ] **L-01 文献图表/表格提取**：图注、表格文本、页面截图。
- [ ] **L-02 跨文献综述**：多文献方法/数据集/创新点矩阵。
- [ ] **L-03 记忆 scope/画像**：user/workspace scope、revision、用户画像；语义 embedding 按既定决定后置。
- [ ] **L-04 工作流复杂条件**：多条件表达式、嵌套子 Agent、失败节点重试、执行树。
- [ ] **L-05 看板增强**：筛选、拖拽排序、任务执行树、预算与用量。
- [ ] **L-06 分支增强**：合并冲突 UI、变更撤销/重放与分支策略。

---

## 13. 横切验收

每个条目完成时必须满足：

- [ ] **Q-01 单元/集成测试**：新增持久化、迁移、取消、并发、权限路径必须有测试。
- [ ] **Q-02 E2E**：用户可见流程至少覆盖浏览器；桌面相关补 Electron。
- [ ] **Q-03 安全**：外部输入、路径、URL、命令、MCP、OAuth、密钥都说明信任边界与校验位置。
- [ ] **Q-04 数据迁移**：SQLite schema 变化必须有显式 migration 和旧数据兼容测试。
- [ ] **Q-05 文档**：README/architecture/检查清单同步；已知边界不留在聊天记录。
- [ ] **Q-06 全量验证**：`pnpm typecheck`、`pnpm check`、`pnpm test`、`pnpm build`、E2E、桌面 E2E。
- [ ] **Q-07 性能**：长会话、SSE 增量、文件树、Trace 快照有上限和按需加载。
- [ ] **Q-08 打包**：桌面安装包可启动，daemon sidecar 正常退出，数据目录正确。
- [ ] **Q-09 体积预算**：源码（不含依赖/构建产物）不超过 5 MB；安装包持续记录基线；`release/` 与 `node_modules/` 不作为交付物提交；精简 Electron locales，模型/原生 helper 不随默认包无界膨胀。

---

## 14. 推荐执行批次

### Batch 1：第一屏（1–2 天）

1. H-01 Hero 首页
2. H-02 Hero Composer
3. H-03 快捷提示
4. H-04 标题区
5. H-05 Navbar
6. H-07 空态
7. H-09 首页 E2E

### Batch 2：Workspace 与侧栏（2–3 天）

1. W-01 数据模型
2. W-02 Service
3. W-03 API
4. W-04 目录选择器
5. W-05 Session 绑定
6. W-06/H-11 侧栏分组
7. W-07/W-08 操作与排序
8. W-09/W-10 兼容与测试
9. H-12/H-13/H-14 会话状态与折叠

### Batch 3：Composer 模型与审批（2–3 天）

1. C-01 模型目录
2. C-02 Model Picker
3. C-03 默认模型
4. C-04/C-05 会话模型切换
5. C-06 推理强度
6. AP-01 三档审批
7. H-02a/H-02b/H-02c 首页工作区/模型/审批控制
8. C-07 Context Usage

### Batch 4：Provider 平台与 HITL（1–2 周）

- C-08～C-11
- AP-02～AP-11
- X-01～X-11

### Batch 5：工具、MCP 与 Skills（2–4 周）

- T-01～T-11
- G-01～G-12
- S-01～S-13

### Batch 6：Trace、用量与富内容（1–2 周）

- U-01～U-07
- R-01～R-11

### Batch 7：Computer Use、Evals 与发布（按平台与优先级）

- P-01～P-08
- L-01～L-06

---

## 15. 当前下一步

Batch 1、Batch 2、Batch 3、C-01～C-10、AP-06～AP-11、X-01～X-11、T-01～T-11（T-05/T-07/T-10 部分）、S-01～S-07、R-01/R-03/R-05/R-07/R-08 与 U-01～U-04 已完成；C-11 OAuth 登录链已接入，真实 Provider 授权待联网验收；AP-02 的 pi Shell 复核已接入。C-08 等 pi SDK 提供统一 verbosity/reasoning summary 选项后再接。

S-08 插件清单按当前决定跳过。下一批可继续 **R-02 跳转上下文、R-04 长会话性能、R-06 富内容块**，或按参考项目推进 MCP/插件生态。

## 16. 新增扩展能力（参考 pi-main / pi-harness）

- [x] **D-01 Durable 续跑**：从 JSONL 重建上次目标、输出与成功工具，用户可手动续跑；不重放未知副作用。
- [x] **F-01 Session FTS**：SQLite FTS5 从 JSONL 派生消息索引，支持中英文、短查询回退、归档排除。
- [ ] ◐ **M-01 Memory 语义化**：支持 OpenAI-compatible Embedding 端点与 FTS/向量 RRF；本地 multilingual-e5 与 user/workspace scope/画像仍待接。
- [x] **S-14 SRT 沙箱**：`@anthropic-ai/sandbox-runtime` 包装 `run_command`，read_only/workspace_write 文件与网络边界，支持凭据环境变量脱敏；SRT 不可用时明确失败，不静默降级。
- [x] **S-15 沙箱设置**：Profile、域名 allow/deny、凭据变量名配置；`full_access` 与 `off` 走宿主执行。

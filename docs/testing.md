# 测试

当前共 **262** 个单元/集成测试，另有 **42** 个浏览器 E2E 与 **1** 个 Electron 客户端 E2E。单元/集成测试使用 Node 内置 `node:test` + `tsx`，不需要网络或 API Key；E2E 使用本地测试模型和本机 Edge（CI 使用 Chromium）。

```bash
pnpm test          # 单元/集成
pnpm test:e2e      # 浏览器/API E2E
pnpm test:desktop  # Electron 客户端 E2E
pnpm typecheck
pnpm check
```

## 测试套件

| 文件                                                   | 数量 | 覆盖                                                                   |
| ------------------------------------------------------ | ---- | ---------------------------------------------------------------------- |
| `packages/policy/test/path.test.ts`                    | 5    | 路径越界、符号链接/受保护目录、命令判定                                |
| `packages/policy/test/command-prefix.test.ts`          | 3    | 安全命令 token 前缀、高风险/复杂命令拒绝、token 匹配                   |
| `packages/core/test/runtime.test.ts`                   | 2    | Agent 循环、工具审批、中止                                             |
| `packages/core/test/m2.test.ts`                        | 6    | 排队输入、工具结果投影、自动重试、上下文压缩、Abort、超窗错误          |
| `packages/core/test/messages.test.ts`                  | 2    | 工具调用组不拆分、孤立 tool_result 清理                                |
| `packages/tools/test/file-list.test.ts`                | 2    | 结构化工作区列表、忽略目录、越界与截断                                 |
| `packages/tools/test/web-fetch.test.ts`                | 5    | SSRF/私网拒绝、重定向、超时、二进制拒绝、大小与字符上限                |
| `packages/tools/test/web-search.test.ts`               | 3    | SearXNG JSON 检索、未配置提示、非 JSON 错误                            |
| `packages/tools/test/view-image.test.ts`               | 3    | 图片内容与尺寸、模型能力、越界路径、格式与边长限制                     |
| `packages/sandbox/test/sandbox.test.ts`                | 5    | read_only/workspace_write、网络 allow/deny、SRT 配置、域名通配规范化   |
| `apps/daemon/test/session-search.test.ts`              | 1    | Session FTS 中英文检索、短查询回退、归档排除、索引清理                 |
| `apps/daemon/test/session-resume.test.ts`              | 1    | Durable 续跑提示：目标、输出、成功工具，不重放副作用                   |
| `apps/daemon/test/embedder-http.test.ts`               | 1    | OpenAI-compatible Embedding、归一化与维度校验                          |
| `apps/daemon/test/event-store.test.ts`                 | 5    | JSONL 追加/重放、末行修复、损坏行跳过                                  |
| `apps/daemon/test/pi-engine.test.ts`                   | 6    | pi Session、工具循环、审批、排队、自动续轮、改写分支、检查点恢复       |
| `apps/daemon/test/auto-follow-up.test.ts`              | 3    | 续轮标记检测、标记清理、`agent_before_settle` 边界与系统提示协议       |
| `apps/daemon/test/pi-tools.test.ts`                    | 1    | 只读工具并行、副作用工具串行                                           |
| `apps/daemon/test/pi-event-bridge.test.ts`             | 1    | 压缩 token/消息数、压缩 usage、自动重试与压缩重试字段                  |
| `apps/daemon/test/request-snapshot.test.ts`            | 2    | 请求快照、图片 base64 省略、长文本/消息截断与 token 估算               |
| `apps/daemon/test/session-history.test.ts`             | 4    | 历史消息/工具输出检索、消息序号、片段上限、`search_history` 工具       |
| `apps/daemon/test/file-change-service.test.ts`         | 4    | 变更撤销/重放、冲突整体拒绝、新建/删除文件、越界路径                   |
| `apps/daemon/test/context-checkpoint.test.ts`          | 4    | 结构化检查点派生、摘要分节、版本链、字段对比与恢复提示                 |
| `apps/daemon/test/approval-coordinator.test.ts`        | 4    | 并发审批乱序解决、force 宿主审批、会话级授权、命令前缀候选             |
| `apps/daemon/test/approval-description.test.ts`        | 2    | 审批目标/风险/影响描述                                                 |
| `apps/daemon/test/approval-review.test.ts`             | 2    | 自动批准下的独立模型复核                                               |
| `apps/daemon/test/user-input.test.ts`                  | 8    | 提问请求/解决/过期、并发、超时、Abort、取消、子 Agent 归属、工具格式   |
| `apps/daemon/test/literature-chunker.test.ts`          | 12   | 章节识别、长文切块、超大页拆分、引用校验                               |
| `apps/daemon/test/literature-analyzer.test.ts`         | 7    | 单片段/map-reduce、失败回退、Abort、服务层进度/取消                    |
| `apps/daemon/test/literature-export.test.ts`           | 3    | Markdown/JSON/BibTeX 导出与转义                                        |
| `apps/daemon/test/knowledge.test.ts`                   | 8    | RAG 索引/替换/删除、中英文 FTS、短查询、`search_knowledge` 工具        |
| `apps/daemon/test/memory.test.ts`                      | 2    | 记忆 CRUD、kind 隔离、本地向量与 FTS 混合召回                          |
| `apps/daemon/test/memory-tools.test.ts`                | 1    | save/search/forget 工具与审批标记                                      |
| `apps/daemon/test/memory-recall.test.ts`               | 3    | 记忆前缀隐藏、召回/计划事件投影                                        |
| `apps/daemon/test/message-image.test.ts`               | 1    | 用户图片块保留为 image content                                         |
| `apps/daemon/test/sub-agent.test.ts`                   | 14   | 子 Agent 投影、未决审批投影、控制工具、spawn/stop、DAG 调度            |
| `apps/daemon/test/board-task.test.ts`                  | 6    | 任务 CRUD/校验、启动/重试、状态派生、审批等待、确认完成                |
| `apps/daemon/test/session-archive.test.ts`             | 2    | Session 归档/恢复、默认列表排除、父会话关系                            |
| `apps/daemon/test/session-fork.test.ts`                | 3    | 会话事件复制、审批收口、历史消息 cutoff、seq/sessionId 重写            |
| `apps/daemon/test/session-recovery.test.ts`            | 3    | 重启补偿未决审批/用户提问/子 Agent/Run、幂等恢复                       |
| `apps/daemon/test/session-projections.test.ts`         | 3    | Run 开始清空 Plan/Todos、工具卡投影、未决提问快照                      |
| `apps/daemon/test/workspace-write-coordinator.test.ts` | 3    | 同路径写锁、不同路径并行、observed-content 变更拒绝                    |
| `apps/daemon/test/session-compare.test.ts`             | 2    | 分支差异、共同前缀、合并摘要                                           |
| `apps/daemon/test/workspace-context.test.ts`           | 4    | AGENTS.md 读取/缺失/截断、主/子 Agent 提示注入                         |
| `apps/daemon/test/workspace-registry.test.ts`          | 4    | 工作区注册、重命名、排序、软移除/恢复                                  |
| `apps/daemon/test/workspace-service.test.ts`           | 2    | 工作区读写、越界、二进制与超大文件                                     |
| `apps/daemon/test/document-tools.test.ts`              | 3    | read_document 文本/XLSX、越界、view_pdf_page 能力/签名/渲染错误        |
| `apps/daemon/test/sandbox-tool-approval.test.ts`       | 3    | 沙箱拒绝后的强制宿主审批、拒绝执行、计划模式硬阻断                     |
| `apps/daemon/test/settings.test.ts`                    | 1    | 沙箱设置默认值、Profile 与域名持久化                                   |
| `apps/daemon/test/skills.test.ts`                      | 6    | SKILL.md 解析、scope 覆盖/禁用、资源加载、skill_creator、安装校验      |
| `apps/daemon/test/usage-trace.test.ts`                 | 3    | 用量聚合、Trace Run/Request/Tool/Approval/消息投影/子 Agent、失败态    |
| `apps/daemon/test/tool-guard.test.ts`                  | 4    | 副作用去重、失败重试、超时、并发上限                                   |
| `apps/daemon/test/config.test.ts`                      | 5    | 自动续轮、SearXNG 与子 Agent 预算默认值/环境变量覆盖                   |
| `apps/daemon/test/background-command-service.test.ts`  | 6    | 后台命令启动/输出/退出/停止、环境白名单、并发上限、沙箱拒绝            |
| `apps/daemon/test/background-command-tools.test.ts`    | 1    | 工具审批标记、启动、读取与列表                                         |
| `apps/daemon/test/code-merge.test.ts`                  | 3    | 三方文件合并、冲突、删除/修改、应用写入                                |
| `apps/daemon/test/git-service.test.ts`                 | 2    | Git 状态/diff/暂存/提交、非仓库错误                                    |
| `apps/daemon/test/workflow-service.test.ts`            | 7    | 工作流 CRUD、DAG、cron/时区/条件、调度与历史                           |
| `apps/daemon/test/workflow-scheduler.test.ts`          | 1    | 定时触发、失败日志与继续调度                                           |
| `apps/daemon/test/workflow-file-watcher.test.ts`       | 1    | 文件变更去抖、真实 fs.watch 触发                                       |
| `apps/daemon/test/attachment-service.test.ts`          | 4    | 文本/XLSX/PPTX 抽取、上下文注入、删除与错误 Session                    |
| `apps/daemon/test/plan-mode.test.ts`                   | 1    | 计划模式在审批前阻断副作用工具                                         |
| `apps/daemon/test/provider-oauth.test.ts`              | 3    | OAuth 登录会话、交互 prompt、取消/登出                                 |
| `apps/daemon/test/provider-settings.test.ts`           | 11   | 模型目录、连接测试、密钥脱敏、自定义 Provider                          |
| `apps/desktop/test/runtime.test.ts`                    | 3    | 客户端路径、动态端口、daemon 健康检查                                  |
| `apps/desktop/test/storage.test.ts`                    | 5    | 数据/缓存目录配置、迁移与回退                                          |
| `apps/web/test/chat-store.test.ts`                     | 13   | 快照 hydrate（含工具卡）、seq 去重、多审批、记忆/计划、diff/Todos/压缩 |
| `apps/web/test/markdown-math.test.ts`                  | 3    | Markdown 公式定界符规范化                                              |
| `apps/web/test/session-tree.test.ts`                   | 2    | 分支树构建、排序、缺失父节点与成环处理                                 |
| `apps/web/test/workflow-model.test.ts`                 | 3    | 工作流模板、空任务、重复 id、缺失依赖、自依赖、环与上限                |

## 原则

- **确定性**：时间/模型/文件系统边界都使用 fake 或临时目录。
- **不碰真实数据**：全部 `mkdtemp`，结束后清理；不写 `data/`。
- **无真实模型**：pi 使用 `faux` provider，builtin 使用 `MockModelClient`。
- **覆盖失败路径**：取消、超时、重复调用、损坏 JSONL、空的模型输出。
- **测试发现的缺陷先修复再加断言**，不把 bug 固化为契约。

## 跑桌面 E2E 前先清掉 `ELECTRON_RUN_AS_NODE`

如果终端本身是 Electron 应用（或从其中派生），会继承 `ELECTRON_RUN_AS_NODE=1`。这个变量让
`electron.exe` 退化成纯 Node 跑主进程，`require("electron").app` 变成 `undefined`，表现为
`pnpm test:desktop` 只报一句没有上下文的 `Process failed to launch!`。

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
pnpm test:desktop
```

判断方法：手工启动 `apps/desktop/node_modules/electron/dist/electron.exe apps/desktop --no-sandbox`，
如果 stderr 出现 `Cannot read properties of undefined (reading 'requestSingleInstanceLock')`，
就是这个问题，和代码无关。

## 尚未自动化的部分

- Computer Use 原生 helper（需要 macOS 权限与签名环境）。
- 真实 Anthropic 调用的端到端回归（需要付费 Key，建议单独 CI job）。
- 子 Agent 面板、文献上传与 HITL 提问卡片的浏览器交互（当前 E2E 覆盖首页 Hero 输入、快捷提示、刷新不创建空会话、首页文档附件、窄屏首页、工作区添加/重命名/会话绑定、命令面板、任务创建、会话搜索/归档恢复、长期记忆、自动召回、图片消息、@ 引用、会话 fork、历史消息 fork、分支树、分支对比/合并、steering、工作流保存/定时/运行历史、cron/条件触发、Webhook、计划模式/计划批准、文档附件、工作区编辑、后台命令、Git、检查点空态/API、编辑重跑、自动续轮、沙箱设置）。HITL 协议、计划修订、检查点、历史检索、请求快照、文件撤销/重放、web 工具、文档工具、沙箱与工具守卫由单元/集成测试覆盖；提问卡片、“生成下一版计划”、检查点双版本对比/恢复、文件撤销/重放和沙箱宿主重跑的完整点击流程仍需浏览器 E2E。Electron E2E 检查客户端窗口、品牌、集成状态栏、工作区分组与存储位置读取；桌面存储配置/迁移由纯函数测试覆盖。

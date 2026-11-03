# Fathom 开发规则

## 命令

- `pnpm typecheck`：所有包 TypeScript 检查。
- `pnpm test`：Node 内置测试（262 项：策略、事件存储、Agent 循环、pi 引擎、文献、RAG、多 Agent、Web store）。
  `pnpm test:e2e`：构建后运行 Playwright 浏览器/API 冒烟测试（22 项）。
  `pnpm test:desktop`：构建并运行 Electron 客户端 E2E（1 项）。
- `pnpm check`：Biome lint + format；提交前必须全绿。
- `pnpm build`：daemon `tsc` + Web `vite build`；桌面端使用 `pnpm desktop:dev` / `pnpm desktop:package`。
- `pnpm dev`：daemon + Vite 并行开发。

改动代码后至少运行：`pnpm typecheck && pnpm test && pnpm check`。
改动 UI 或构建配置时再跑 `pnpm build`。

## 架构约束

- 默认执行内核是 pi SDK（`apps/daemon/src/pi`）；`packages/core` 只保留共享事件/消息契约与旧 builtin 运行时，不得依赖 daemon、文件系统或 Web。
- pi 引擎关闭内置工具、外部扩展/Skill/Prompt/Context 文件自动加载；新增能力必须经过我们的工具、策略与审批。
- daemon 是唯一组装根；工具/Provider/策略通过端口接入。
- JSONL 是 Session 事实源；SQLite 只存索引与元数据。
- 事件序号由 AgentRuntime 唯一分配；daemon 不得绕过 emitter 直接写事件。
- 审批是协议事件，不是特例分支；新工具必须声明 `requiresApproval`。
- 新增外部输入（路径、命令、URL、模型输出）必须指出信任边界与校验位置。
- **M1–M4 不实现 MCP**；不要提前引入 MCP SDK 或服务器配置。

## 安全红线

- 不做 URL 前缀鉴权；鉴权放路由级 hook。
- 文件工具必须用 `resolveWorkspacePath` 返回的 realpath 路径。
- 不在 Windows 上依赖 POSIX 权限位。
- 不把不可信参数拼进 PowerShell `-Command`。
- 外部链接 `target="_blank"` 必须带 `rel="noopener noreferrer"`。
- Markdown 渲染保持默认转义，不启用 raw HTML。

## 代码风格

- TypeScript strict；避免 `any`。
- 事件/工具/消息使用可辨识联合；不要用布尔旗标堆分支。
- 注释只解释“为什么”，不解释“下一行做什么”。
- 新增持久化、取消、并发路径必须有测试。
- 不修改 `data/` 下运行时产物；测试使用临时目录。
- 不提交 `.env`、`data/`、`dist/`。

## 里程碑

见 `docs/roadmap.md`。每个里程碑结束前：

1. 更新 README 的已知边界；
2. 跑完整检查；
3. 手动冒烟 Mock 模式的对话 + 审批 + 文献流程。

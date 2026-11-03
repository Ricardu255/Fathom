import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentsContext, MAX_AGENTS_CONTEXT_BYTES } from "../src/pi/workspace-context";
import { buildSubAgentPrompt, buildSystemPrompt } from "../src/prompts";

async function withWorkspace(run: (workspaceRoot: string) => Promise<void>): Promise<void> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fathom-agents-"));
  try {
    await run(workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

test("读取 workspace 根目录的 AGENTS.md", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(join(workspaceRoot, "AGENTS.md"), "始终使用 pnpm。\n跑完测试再提交。", "utf8");
    const context = await loadAgentsContext(workspaceRoot);
    assert.equal(context, "始终使用 pnpm。\n跑完测试再提交。");
  });
});

test("AGENTS.md 缺失、为空或是目录时返回 null", async () => {
  await withWorkspace(async (workspaceRoot) => {
    assert.equal(await loadAgentsContext(workspaceRoot), null);
    await writeFile(join(workspaceRoot, "AGENTS.md"), "   \n", "utf8");
    assert.equal(await loadAgentsContext(workspaceRoot), null);
    await rm(join(workspaceRoot, "AGENTS.md"));
    await mkdir(join(workspaceRoot, "AGENTS.md"));
    assert.equal(await loadAgentsContext(workspaceRoot), null);
  });
});

test("AGENTS.md 超过上限时截断并标注", async () => {
  await withWorkspace(async (workspaceRoot) => {
    await writeFile(join(workspaceRoot, "AGENTS.md"), "a".repeat(MAX_AGENTS_CONTEXT_BYTES + 100));
    const context = await loadAgentsContext(workspaceRoot);
    assert.ok(context !== null);
    assert.equal(context.startsWith("a".repeat(MAX_AGENTS_CONTEXT_BYTES)), true);
    assert.match(context, /已按 16384 字节上限截断/u);
  });
});

test("系统提示与子 Agent 提示会注入 AGENTS.md，空内容不注入", () => {
  const system = buildSystemPrompt("/tmp/workspace", "始终使用 pnpm。");
  assert.match(system, /Workspace AGENTS\.md/u);
  assert.match(system, /始终使用 pnpm。/u);
  assert.match(system, /<<<AGENTS\.md/u);

  const without = buildSystemPrompt("/tmp/workspace");
  assert.doesNotMatch(without, /Workspace AGENTS\.md/u);

  const child = buildSubAgentPrompt(
    "worker",
    "worker-1",
    "修复类型错误",
    "/tmp/workspace",
    "先跑测试。",
  );
  assert.match(child, /先跑测试。/u);
  assert.doesNotMatch(
    buildSubAgentPrompt("worker", "worker-1", "修复类型错误", "/tmp/workspace"),
    /Workspace AGENTS\.md/u,
  );
});

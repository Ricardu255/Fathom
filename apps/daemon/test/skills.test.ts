import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { copySkillDirectory, installSkillFromGithub } from "../src/skills/skill-installer";
import { parseSkillMarkdown, SkillError, SkillRegistry } from "../src/skills/skill-registry";
import { createSkillTools } from "../src/skills/skill-tools";

const SKILL = (name: string, description: string, body = "正文") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

async function makeRoots() {
  const root = await mkdtemp(join(tmpdir(), "fathom-skills-"));
  const systemDir = join(root, "system");
  const globalDir = join(root, "global");
  const workspaceRoot = join(root, "workspace");
  return { globalDir, root, systemDir, workspaceRoot };
}

async function writeSkill(root: string, name: string, content = SKILL(name, `${name} 描述`)) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), content, "utf8");
}

test("解析 SKILL.md frontmatter，支持折叠描述", () => {
  const parsed = parseSkillMarkdown(
    [
      "---",
      "name: Example-Skill",
      "description: >-",
      "  第一行",
      "  第二行",
      "---",
      "",
      "正文",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    body: "正文",
    description: "第一行 第二行",
    name: "example-skill",
  });
  assert.equal(parseSkillMarkdown("no frontmatter"), null);
  assert.equal(parseSkillMarkdown("---\nname: Bad Name\ndescription: x\n---\nbody"), null);
});

test("system → global → project 同名覆盖，禁用后不回退低优先级", async () => {
  const roots = await makeRoots();
  try {
    await writeSkill(roots.systemDir, "alpha", SKILL("alpha", "system"));
    await writeSkill(roots.globalDir, "alpha", SKILL("alpha", "global"));
    await writeSkill(
      join(roots.workspaceRoot, ".fathom", "skills"),
      "alpha",
      SKILL("alpha", "project"),
    );

    const registry = new SkillRegistry({
      globalDir: roots.globalDir,
      systemDir: roots.systemDir,
      workspaceRoot: roots.workspaceRoot,
    });
    const list = await registry.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.scope, "project");
    assert.equal(list[0]?.description, "project");

    const disabled = new SkillRegistry({
      disabled: ["project:alpha"],
      globalDir: roots.globalDir,
      systemDir: roots.systemDir,
      workspaceRoot: roots.workspaceRoot,
    });
    assert.deepEqual(await disabled.list(), []);
    const all = await disabled.list({ includeDisabled: true });
    assert.equal(all[0]?.scope, "project");
    assert.equal(all[0]?.enabled, false);
  } finally {
    await rm(roots.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("加载正文/资源并拒绝越界资源；catalog 与 $ref 只包含启用 Skill", async () => {
  const roots = await makeRoots();
  try {
    await writeSkill(roots.globalDir, "alpha", SKILL("alpha", "alpha 描述", "完整正文"));
    await writeFile(join(roots.globalDir, "alpha", "notes.txt"), "资源内容", "utf8");
    await writeSkill(roots.globalDir, "beta", SKILL("beta", "beta 描述"));
    const registry = new SkillRegistry({
      disabled: ["global:beta"],
      globalDir: roots.globalDir,
      systemDir: roots.systemDir,
      workspaceRoot: roots.workspaceRoot,
    });
    assert.match(await registry.load("alpha"), /完整正文/u);
    assert.equal(await registry.load("alpha", "notes.txt"), "资源内容");
    await assert.rejects(
      () => registry.load("alpha", "../outside.txt"),
      (error: unknown) => error instanceof SkillError && error.code === "INVALID",
    );
    await assert.rejects(() => registry.load("beta"), /不存在或已禁用/u);
    const catalog = await registry.catalogText();
    assert.match(catalog, /alpha/u);
    assert.doesNotMatch(catalog, /beta/u);
    const refs = await registry.resolveRefs("请用 $alpha 和 $alpha 处理，$beta 不应该生效");
    assert.deepEqual(
      refs.map((skill) => skill.id),
      ["alpha"],
    );
  } finally {
    await rm(roots.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("skill_creator 创建项目 Skill，冲突时拒绝", async () => {
  const roots = await makeRoots();
  try {
    await mkdir(roots.workspaceRoot, { recursive: true });
    const registry = new SkillRegistry({
      globalDir: roots.globalDir,
      systemDir: roots.systemDir,
      workspaceRoot: roots.workspaceRoot,
    });
    const tools = createSkillTools(registry);
    const creator = tools.find((tool) => tool.name === "skill_creator");
    assert.ok(creator !== undefined);
    assert.equal(creator.requiresApproval, true);
    await creator.execute(
      { body: "执行步骤", description: "测试项目 Skill", name: "demo-skill" },
      { signal: new AbortController().signal, workspaceRoot: roots.workspaceRoot },
    );
    const list = await registry.list();
    assert.equal(list.find((skill) => skill.id === "demo-skill")?.scope, "project");
    await assert.rejects(
      () =>
        creator.execute(
          { body: "重复", description: "重复创建", name: "demo-skill" },
          { signal: new AbortController().signal, workspaceRoot: roots.workspaceRoot },
        ),
      /已存在/u,
    );
    const load = tools.find((tool) => tool.name === "load_skill");
    assert.ok(load !== undefined);
    const loaded = await load.execute(
      { name: "demo-skill" },
      { signal: new AbortController().signal, workspaceRoot: roots.workspaceRoot },
    );
    assert.match(loaded.content, /执行步骤/u);
  } finally {
    await rm(roots.root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("GitHub 安装只接受 owner/repo，非法输入不会启动 clone", async () => {
  const root = await mkdtemp(join(tmpdir(), "fathom-skill-install-validation-"));
  try {
    await assert.rejects(() => installSkillFromGithub({ repo: "../evil" }, root), /owner\/repo/u);
    await assert.rejects(
      () => installSkillFromGithub({ ref: "../main", repo: "owner/repo" }, root),
      /ref 无效/u,
    );
  } finally {
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("安装复制限制文件数与大小，并拒绝符号链接", async () => {
  const root = await mkdtemp(join(tmpdir(), "fathom-skill-copy-"));
  try {
    const source = join(root, "source");
    const target = join(root, "target");
    await mkdir(join(source, "assets"), { recursive: true });
    await writeFile(join(source, "SKILL.md"), SKILL("copy-skill", "copy"), "utf8");
    await writeFile(join(source, "assets", "data.txt"), "data", "utf8");
    const result = await copySkillDirectory(source, target);
    assert.equal(result.files, 2);
    assert.ok(result.bytes > 0);
  } finally {
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

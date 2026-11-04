import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAllowedTools, parseSkillMarkdown } from "../src/skills/skill-registry";

function skill(frontmatter: string, body = "说明正文。"): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

test("解析 name 与 description，正文单独返回", () => {
  const parsed = parseSkillMarkdown(skill("name: pdf-tools\ndescription: 处理 PDF"));
  assert.equal(parsed?.name, "pdf-tools");
  assert.equal(parsed?.description, "处理 PDF");
  assert.equal(parsed?.body, "说明正文。");
  assert.equal(parsed?.license, undefined);
  assert.equal(parsed?.compatibility, undefined);
  assert.equal(parsed?.allowedTools, undefined);
});

test("解析规范里的 license、compatibility 与 allowed-tools", () => {
  const parsed = parseSkillMarkdown(
    skill(
      [
        "name: pdf-tools",
        "description: 处理 PDF",
        "license: MIT",
        "compatibility: 需要系统安装 pdftotext",
        "allowed-tools: Read, Grep",
      ].join("\n"),
    ),
  );
  assert.equal(parsed?.license, "MIT");
  assert.equal(parsed?.compatibility, "需要系统安装 pdftotext");
  assert.deepEqual(parsed?.allowedTools, ["Read", "Grep"]);
});

test("allowed-tools 支持 YAML 列表与方括号两种写法", () => {
  const block = parseSkillMarkdown(
    skill(["name: a-1", "description: 描述", "allowed-tools:", "  - Read", "  - Bash"].join("\n")),
  );
  assert.deepEqual(block?.allowedTools, ["Read", "Bash"]);

  const flow = parseSkillMarkdown(
    skill(["name: b-2", "description: 描述", "allowed-tools: [Read, Grep]"].join("\n")),
  );
  assert.deepEqual(flow?.allowedTools, ["Read", "Grep"]);
});

test("空白可选字段不会变成空字符串", () => {
  const parsed = parseSkillMarkdown(
    skill(["name: c-3", "description: 描述", "license:", "allowed-tools:  ,  "].join("\n")),
  );
  assert.equal(parsed?.license, undefined);
  assert.equal(parsed?.allowedTools, undefined);
});

test("缺少 name 或 description 时整体判为无效", () => {
  assert.equal(parseSkillMarkdown(skill("description: 没有名字")), null);
  assert.equal(parseSkillMarkdown(skill("name: d-4")), null);
  // 下划线不在规范允许的字符集里。
  assert.equal(parseSkillMarkdown(skill("name: bad_name\ndescription: 描述")), null);
  assert.equal(parseSkillMarkdown("没有 frontmatter"), null);
});

test("name 大小写被归一化而不是判为无效", () => {
  assert.equal(parseSkillMarkdown(skill("name: BadName\ndescription: 描述"))?.name, "badname");
});

test("parseAllowedTools 会去掉引号与空白", () => {
  assert.deepEqual(parseAllowedTools("\"Read\", 'Grep'"), ["Read", "Grep"]);
  assert.equal(parseAllowedTools(""), undefined);
  assert.equal(parseAllowedTools("[]"), undefined);
  assert.equal(parseAllowedTools(undefined), undefined);
});

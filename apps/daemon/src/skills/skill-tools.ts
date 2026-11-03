import type { Tool, ToolResult } from "@harness/core";
import { z } from "zod";
import type { SkillRegistry } from "./skill-registry";

const findSchema = z.object({
  limit: z.number().int().min(1).max(20).default(10),
  query: z.string().max(200).optional(),
});

const nameSchema = z.object({
  name: z.string().min(1).max(64),
});

const loadSchema = z.object({
  name: z.string().min(1).max(64),
  resource: z.string().min(1).max(1_024).optional(),
});

const creatorSchema = z.object({
  body: z.string().min(1).max(200_000),
  description: z.string().min(1).max(2_000),
  name: z.string().min(1).max(64),
});

export function createSkillTools(registry: SkillRegistry): Tool[] {
  return [
    {
      description:
        "查找当前 Session 可用的 Skills，按名称/描述过滤。返回名称、scope 与描述；需要正文时调用 load_skill。",
      async execute(input): Promise<ToolResult> {
        const parsed = findSchema.parse(input);
        const query = parsed.query?.trim().toLowerCase() ?? "";
        const skills = (await registry.list()).filter(
          (skill) =>
            query === "" ||
            skill.name.includes(query) ||
            skill.id.includes(query) ||
            skill.description.toLowerCase().includes(query),
        );
        if (skills.length === 0) return { content: "没有找到匹配的 Skill。" };
        return {
          content: skills
            .slice(0, parsed.limit)
            .map(
              (skill) =>
                `- ${skill.name} [${skill.scope}]：${skill.description.replace(/\s+/gu, " ").slice(0, 300)}`,
            )
            .join("\n"),
        };
      },
      inputSchema: toJsonSchema(findSchema),
      name: "find_skill",
      parse: (input) => findSchema.parse(input),
      requiresApproval: false,
      summarize: (input) => {
        const parsed = findSchema.parse(input);
        return parsed.query === undefined ? "列出 Skills" : `查找 Skill：${parsed.query}`;
      },
    },
    {
      description:
        "读取一个 Skill 的元数据与资源文件列表，不返回正文。正文用 load_skill(name)，资源用 load_skill(name, resource)。",
      async execute(input): Promise<ToolResult> {
        const parsed = nameSchema.parse(input);
        const skills = await registry.list({ includeDisabled: true });
        const skill = skills.find((item) => item.name === parsed.name || item.id === parsed.name);
        if (skill === undefined) return { content: `Skill 不存在：${parsed.name}`, isError: true };
        const detail = await registry.detail(skill.scope, skill.id);
        const lines = [
          `Skill: ${detail.name}`,
          `Scope: ${detail.scope}`,
          `Enabled: ${detail.enabled ? "yes" : "no"}`,
          `Description: ${detail.description}`,
          detail.resources.length === 0 ? "Resources: 无" : "Resources:",
          ...detail.resources.map((resource) => `- ${resource.path} (${resource.size} bytes)`),
        ];
        return { content: lines.join("\n") };
      },
      inputSchema: toJsonSchema(nameSchema),
      name: "get_skill",
      parse: (input) => nameSchema.parse(input),
      requiresApproval: false,
      summarize: (input) => `读取 Skill 元数据：${nameSchema.parse(input).name}`,
    },
    {
      description:
        "加载一个 Skill 的 SKILL.md 正文，或加载其目录内的指定文本资源。只读；资源路径不能越出 Skill 目录。",
      async execute(input): Promise<ToolResult> {
        const parsed = loadSchema.parse(input);
        const content = await registry.load(parsed.name, parsed.resource);
        return { content };
      },
      inputSchema: toJsonSchema(loadSchema),
      name: "load_skill",
      parse: (input) => loadSchema.parse(input),
      requiresApproval: false,
      summarize: (input) => {
        const parsed = loadSchema.parse(input);
        return parsed.resource === undefined
          ? `加载 Skill：${parsed.name}`
          : `加载 Skill 资源：${parsed.name}/${parsed.resource}`;
      },
    },
    {
      description:
        "在 workspace 的 .fathom/skills/<name>/SKILL.md 创建一个项目 Skill。需要用户批准；同名 Skill 不会被覆盖。",
      async execute(input): Promise<ToolResult> {
        const parsed = creatorSchema.parse(input);
        const skill = await registry.createProjectSkill(parsed);
        return {
          content: `已创建项目 Skill ${skill.name}：${skill.skillFile}`,
        };
      },
      inputSchema: toJsonSchema(creatorSchema),
      name: "skill_creator",
      parse: (input) => creatorSchema.parse(input),
      requiresApproval: true,
      summarize: (input) => `创建项目 Skill：${creatorSchema.parse(input).name}`,
    },
  ];
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema) as Record<string, unknown>;
  delete result.$schema;
  return result;
}

# System Skills

这里存放随应用分发的 system scope Skills。每个 Skill 是一个子目录，包含 `SKILL.md`：

```text
skills/
└── example-skill/
    └── SKILL.md
```

`SKILL.md` 必须包含 frontmatter：

```markdown
---

name: example-skill
description: 何时使用这个 Skill
---

正文与可选的资源文件说明。
```

优先级：system → global（`data/skills`）→ project（`<workspace>/.fathom/skills`、`<workspace>/.agents/skills`）。
同名 Skill 由更高优先级覆盖；在设置页禁用的 Skill 不会回退到低优先级版本。

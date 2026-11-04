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

## 规范字段

除 `name` 与 `description` 外，还支持 Agent Skills 规范里的这几个可选字段：

```markdown
---

name: pdf-tools
description: 处理 PDF 文件
license: MIT
compatibility: 需要系统安装 pdftotext
allowed-tools:
- read_file
- run_command

---
```

- `allowed-tools`：声明式预授权清单，只是提示；实际执行仍走审批与策略。
- `compatibility`：环境要求，写清楚缺什么会失败。
- `license`：许可证名称或随附文件。

`allowed-tools` 支持 YAML 列表、`[a, b]` 和逗号分隔三种写法。

## 项目级 Skill 放在哪

- **`.fathom/skills/`** 是 Fathom 自己的约定，默认会被提交进仓库。
- **`.agents/skills/`** 是 pi 的约定，运行时同样会被发现；但本仓库的 `.gitignore` 忽略了 `.agents/`（那里放的是本机工具链），
  所以放在这里的项目 Skill **不会**被提交。要随仓库分发，请放 `.fathom/skills/`。

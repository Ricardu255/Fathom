# 文献解析模块

这是一个独立的**文献工作窗口**，目标不是聊天附件，而是把一篇 PDF 快速变成可用的知识资产：
知识清单、技术路线、创新点、实验与局限，并保留页码引用。

## 1. 当前实现（M3）

```text
上传 PDF
  → 校验 %PDF- / 30 MiB
  → 存入 data/literature/<id>/source.pdf
  → unpdf 逐页抽取（保留换行/段落，便于章节识别）
  → data/literature/<id>/text.json
  → 用户点击“生成知识清单”
  → chunkDocument：章节识别 + 按页切块（单块 ≤60k 字符走单次，否则 map-reduce）
  → Map：每个片段抽取 claims/methods/experiments/limitations/innovations/steps（绝对页码）
  → Reduce：合并去重、解决冲突，生成最终报告
  → validateReportCitations：页码范围、evidence 原文匹配、confidence/citationStatus
  → zod 校验 → 写入 SQLite.report_json + meta
  → Web 分 Tab 展示，进度/阶段可轮询，可取消
```

状态机：

```text
ready ──analyze──▶ analyzing ──成功──▶ done
                       └────失败────▶ failed（可重试）
```

安全/可靠性：

- 只接受 `%PDF-` 魔数与 30 MiB 以内文件；
- 解压后的文本按页保存，原文不进入 SQLite；
- daemon 重启时把残留的 `analyzing` 标记为失败，避免永久卡住；
- 报告 JSON 校验失败 → 状态 failed，保留错误信息；
- 删除解析中的文献会先中止分析，再删除记录与知识库索引。

## 2. 报告结构

```ts
interface LiteratureReport {
  title: string;
  authors: string[];
  summary: string;
  researchQuestions: string[];
  methods: string[];
  technicalRoute: { step: string; description: string; pages: number[] }[];
  innovations: { title: string; description: string; pages: number[] }[];
  contributions: string[];
  experiments: string[];
  limitations: string[];
  keywords: string[];
  knowledgeChecklist: {
    item: string;
    importance: "high" | "medium" | "low";
    pages: number[];
  }[];
}
```

`pages` 从 1 开始，是**原文页码**，不是抽取数组下标。M3 已加入确定性引用校验与 confidence/citationStatus。

## 3. 已实现的长文策略（M3）

- **章节识别**：编号标题、常见章节名、中文编号标题；普通句子不误判。
- **按页切块**：目标约 18k 字符，最多 16 块；超大单页会按段落拆成多个 part。
- **Map**：片段级结构化抽取，页码使用原文绝对页码；失败片段跳过并记录。
- **Reduce**：合并重复/冲突，生成最终报告；失败时用片段结果做回退。
- **引用校验**：页码越界移除；evidence 规范化后必须出现在引用页（或自动补页）；
  找不到依据标 `unverified/low`，不直接删除。
- **进度**：`reading → analyzing/mapping → reducing → validating → done`；可取消。

## 4. 为什么不是“一次总结”

单次总结容易丢三落四，尤其是 20 页以上的论文。路线如下：

### 4.1 分块与来源

- 以页为基础块，保留 `[p.N]`；
- 按章节标题做粗切分（Introduction / Method / Experiments / Conclusion）；
- 每块带最小元数据（标题、页码范围、字符数）。

### 4.2 Map-Reduce

- Map：每块抽取 `claims / methods / evidence / limitations`，每条带页码；
- Reduce：按主题聚类，合并重复结论，检测冲突；
- 最后生成知识清单、技术路线与创新点；
- 所有条目保留来源页集合。

### 4.3 引用校验

- 检查 `pages` 是否在 `1..pageCount`；
- 用关键词/句子重叠做“引用是否真的支持该结论”的启发式检查；
- 低置信条目标为“待核对”，而不是直接删掉；
- 前端点击 `p.N` 跳到全文对应页。

### 4.4 多模态（后续）

- 图表：抽取图注 + 页截图，交给视觉模型；
- 表格：保留表头与行列结构，避免被纯文本打散；
- 公式：保留 LaTeX 或截图引用。

## 5. 跨文献工作台（下一阶段）

- 文献库：标签、收藏、搜索（标题/作者/关键词/正文）；
- 对比矩阵：方法、数据集、指标、结论；
- 研究脉络：按年份/引用关系组织；
- 综述草稿：多篇文献的共识、分歧、空白；
- 导出：Markdown / JSON / BibTeX。

## 6. 前端交互

- 左侧文献库，右侧详情；
- Tab：概览 / 知识清单 / 技术路线 / 创新点 / 全文；
- 页码 chip 可点击跳转；
- 解析中轮询状态（1.5s），列表 8s 刷新；
- 拖拽或按钮上传；
- 失败可重试，原文永不丢。

## 7. 质量评估

建议从 M3 开始建立固定评测集：

- 10–20 篇不同领域论文；
- 人工标注：关键贡献、方法步骤、实验设置、局限；
- 指标：条目召回、引用正确率、幻觉率、结构合法率；
- 每次改提示词/模型都跑一遍，不靠主观感受。

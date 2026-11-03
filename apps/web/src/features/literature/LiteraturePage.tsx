import type { LiteratureReport } from "@harness/core/literature";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Download,
  FileText,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../api/client";
import {
  knowledgeSearchQueryOptions,
  literatureDetailQueryOptions,
  literatureListQueryOptions,
  literatureTextQueryOptions,
  queryKeys,
} from "../../api/queries";
import type { LiteratureDetail, LiteratureStatus } from "../../api/types";
import { Markdown } from "../../components/Markdown";

type Tab = "checklist" | "innovations" | "overview" | "route" | "text";
type ExportFormat = "bibtex" | "json" | "markdown";
const EXPORT_LABEL: Record<ExportFormat, string> = {
  bibtex: "BibTeX",
  json: "JSON",
  markdown: "Markdown",
};

const TABS: readonly { id: Tab; label: string }[] = [
  { id: "overview", label: "概览" },
  { id: "checklist", label: "知识清单" },
  { id: "route", label: "技术路线" },
  { id: "innovations", label: "创新点" },
  { id: "text", label: "全文" },
];

const STATUS_LABEL: Record<LiteratureStatus, string> = {
  analyzing: "解析中",
  done: "已解析",
  failed: "失败",
  ready: "待解析",
};

export function LiteraturePage() {
  const queryClient = useQueryClient();
  const listQuery = useQuery(literatureListQueryOptions());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [page, setPage] = useState(1);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("markdown");
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const deferredKnowledgeQuery = useDeferredValue(knowledgeQuery);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const list = listQuery.data;
  useEffect(() => {
    if (list === undefined) return;
    if (selectedId === null && list[0] !== undefined) setSelectedId(list[0].id);
    if (selectedId !== null && !list.some((item) => item.id === selectedId)) {
      setSelectedId(list[0]?.id ?? null);
    }
  }, [list, selectedId]);

  const detailQuery = useQuery({
    ...literatureDetailQueryOptions(selectedId ?? ""),
    enabled: selectedId !== null,
  });
  const textQuery = useQuery(
    literatureTextQueryOptions(selectedId ?? "", selectedId !== null && tab === "text"),
  );
  const knowledgeQueryResult = useQuery(knowledgeSearchQueryOptions(deferredKnowledgeQuery));

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.literature() }),
      selectedId === null
        ? Promise.resolve()
        : queryClient.invalidateQueries({ queryKey: queryKeys.literature(selectedId) }),
    ]);
  };

  const uploadMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return apiFetch<LiteratureDetail>("/api/literature/upload", {
        body: form,
        method: "POST",
      });
    },
    onError: (error: unknown) => {
      setUploadError(error instanceof Error ? error.message : "上传失败");
    },
    onSuccess: async (record) => {
      setUploadError(null);
      setSelectedId(record.id);
      setTab("overview");
      setPage(1);
      await refresh();
    },
  });

  const analyzeMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<LiteratureDetail>(`/api/literature/${encodeURIComponent(id)}/analyze`, {
        method: "POST",
      }),
    onSuccess: refresh,
  });

  const cancelMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<LiteratureDetail>(`/api/literature/${encodeURIComponent(id)}/cancel`, {
        method: "POST",
      }),
    onSuccess: refresh,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/literature/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: async (_result, id) => {
      if (selectedId === id) setSelectedId(null);
      await refresh();
    },
  });

  const upload = (file: File | undefined) => {
    if (file === undefined) return;
    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      setUploadError("请选择 PDF 文件");
      return;
    }
    uploadMutation.mutate(file);
  };

  const detail = detailQuery.data;
  const report = detail?.report ?? null;

  const downloadReport = () => {
    if (detail === undefined || report === null) return;
    const anchor = document.createElement("a");
    anchor.href = `/api/literature/${encodeURIComponent(detail.id)}/export?format=${exportFormat}`;
    anchor.download = "";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };

  return (
    <div className="literature-page">
      <header className="literature-header">
        <div>
          <h1>
            <BookOpen size={20} /> 文献解析
          </h1>
          <p>上传 PDF，让 Agent 逐页抽取知识清单、技术路线与创新点，并保留页码引用。</p>
        </div>
        <div className="literature-header-actions">
          <input
            accept="application/pdf,.pdf"
            className="hidden-input"
            onChange={(event) => {
              upload(event.target.files?.[0]);
              event.target.value = "";
            }}
            ref={fileInputRef}
            type="file"
          />
          <button
            className="btn btn-primary"
            disabled={uploadMutation.isPending}
            onClick={() => fileInputRef.current?.click()}
            type="button"
          >
            {uploadMutation.isPending ? (
              <Loader2 className="spin" size={15} />
            ) : (
              <Upload size={15} />
            )}
            {uploadMutation.isPending ? "正在解析 PDF…" : "上传 PDF"}
          </button>
        </div>
      </header>

      {uploadError !== null ? <div className="inline-error">{uploadError}</div> : null}

      <div className="knowledge-search">
        <Search size={15} />
        <input
          aria-label="检索知识库"
          onChange={(event) => setKnowledgeQuery(event.target.value)}
          placeholder="在文献中检索概念、方法或结论…"
          value={knowledgeQuery}
        />
        {knowledgeQuery.trim() !== "" ? (
          <button
            aria-label="清除检索"
            className="knowledge-clear"
            onClick={() => setKnowledgeQuery("")}
            type="button"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>
      {knowledgeQuery.trim() !== "" ? (
        <div className="knowledge-results">
          {knowledgeQueryResult.isPending ? (
            <div className="knowledge-empty">检索中…</div>
          ) : (knowledgeQueryResult.data ?? []).length === 0 ? (
            <div className="knowledge-empty">没有匹配片段</div>
          ) : (
            knowledgeQueryResult.data?.map((hit) => (
              <button
                className="knowledge-result"
                key={hit.chunkId}
                onClick={() => {
                  if (hit.sourceId === null) return;
                  setSelectedId(hit.sourceId);
                  setTab("text");
                  setPage(hit.pageStart);
                  setKnowledgeQuery("");
                }}
                type="button"
              >
                <span className="knowledge-result-title">
                  {hit.documentTitle}
                  <span className="page-chip">
                    p.{hit.pageStart}
                    {hit.pageEnd !== hit.pageStart ? `-${hit.pageEnd}` : ""}
                  </span>
                </span>
                <span className="knowledge-result-text">{hit.content.slice(0, 220)}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
      <div
        aria-label="文献拖拽上传区域"
        className={`literature-layout${dragActive ? " drag-active" : ""}`}
        role="application"
        onDragLeave={() => setDragActive(false)}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          upload(event.dataTransfer.files[0]);
        }}
      >
        <aside className="literature-list">
          <div className="section-label">文献库</div>
          {listQuery.isPending || list === undefined ? (
            <div className="sidebar-empty">加载中…</div>
          ) : list.length === 0 ? (
            <div className="literature-empty-list">
              <FileText size={22} />
              <span>还没有文献</span>
              <small>上传 PDF 或拖拽到此区域</small>
            </div>
          ) : (
            list.map((item) => (
              <button
                className={`literature-item${selectedId === item.id ? " active" : ""}`}
                key={item.id}
                onClick={() => {
                  setSelectedId(item.id);
                  setTab("overview");
                  setPage(1);
                }}
                type="button"
              >
                <div className="literature-item-top">
                  <span className="literature-item-title">{item.title}</span>
                  <StatusBadge status={item.status} />
                </div>
                <div className="literature-item-meta">
                  {item.pageCount} 页 · {Math.round(item.charCount / 1000)}k 字符
                  {item.status === "analyzing"
                    ? ` · ${stageLabel(item.stage)} ${Math.round(item.progress ?? 0)}%`
                    : ` · ${new Date(item.updatedAt).toLocaleDateString()}`}
                </div>
              </button>
            ))
          )}
        </aside>

        <main className="literature-detail">
          {detail === undefined ? (
            <div className="literature-placeholder">
              <BookOpen size={26} />
              <h2>选择或上传一篇文献</h2>
              <p>解析结果会保存在本地，可随时回看，也可以重新生成。</p>
            </div>
          ) : (
            <>
              <div className="literature-detail-head">
                <div>
                  <h2>{detail.title}</h2>
                  <div className="literature-meta">
                    {detail.fileName} · {detail.pageCount} 页 · {detail.charCount.toLocaleString()}{" "}
                    字符
                  </div>
                </div>
                <div className="literature-actions">
                  {report !== null ? (
                    <div className="literature-export">
                      <select
                        aria-label="导出格式"
                        onChange={(event) => setExportFormat(event.target.value as ExportFormat)}
                        value={exportFormat}
                      >
                        {Object.entries(EXPORT_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                      <button className="btn btn-ghost" onClick={downloadReport} type="button">
                        <Download size={14} /> 导出
                      </button>
                    </div>
                  ) : null}
                  <button
                    className="btn btn-ghost"
                    disabled={analyzeMutation.isPending || detail.status === "analyzing"}
                    onClick={() => analyzeMutation.mutate(detail.id)}
                    type="button"
                  >
                    {detail.status === "analyzing" || analyzeMutation.isPending ? (
                      <Loader2 className="spin" size={15} />
                    ) : report === null ? (
                      <Sparkles size={15} />
                    ) : (
                      <RefreshCw size={15} />
                    )}
                    {report === null ? "生成知识清单" : "重新解析"}
                  </button>
                  {detail.status === "analyzing" ? (
                    <button
                      className="btn btn-ghost"
                      disabled={cancelMutation.isPending}
                      onClick={() => cancelMutation.mutate(detail.id)}
                      type="button"
                    >
                      <Square size={14} /> 取消
                    </button>
                  ) : null}
                  <button
                    aria-label="删除文献"
                    className="btn btn-ghost danger"
                    disabled={deleteMutation.isPending}
                    onClick={() => {
                      if (window.confirm(`删除“${detail.title}”？`)) {
                        deleteMutation.mutate(detail.id);
                      }
                    }}
                    type="button"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>

              {detail.status === "failed" ? (
                <div className="inline-error error-banner">
                  <span>{detail.error ?? "解析失败"}</span>
                  <button
                    className="btn btn-ghost"
                    onClick={() => analyzeMutation.mutate(detail.id)}
                    type="button"
                  >
                    重试
                  </button>
                </div>
              ) : null}

              {detail.status === "analyzing" ? (
                <div className="literature-progress">
                  <Loader2 className="spin" size={20} />
                  <div className="literature-progress-body">
                    <strong>{stageLabel(detail.stage)}</strong>
                    <p>
                      {detail.chunkCount === null
                        ? "正在读取 PDF 并切分页面…"
                        : `已切分为 ${detail.chunkCount} 个片段；长文献会逐段抽取后再汇总。`}
                    </p>
                    <div className="progress-track">
                      <span style={{ width: `${Math.max(2, detail.progress ?? 0)}%` }} />
                    </div>
                    <small>{Math.round(detail.progress ?? 0)}%</small>
                  </div>
                </div>
              ) : null}

              {detail.status === "ready" && report === null ? (
                <div className="literature-progress ready">
                  <Sparkles size={20} />
                  <div>
                    <strong>PDF 已解析为文本</strong>
                    <p>点击“生成知识清单”，让模型整理摘要、技术路线与创新点。</p>
                  </div>
                </div>
              ) : null}

              <div className="tabs" role="tablist">
                {TABS.map((item) => (
                  <button
                    aria-selected={tab === item.id}
                    className={`tab${tab === item.id ? " active" : ""}`}
                    disabled={item.id !== "text" && report === null}
                    key={item.id}
                    onClick={() => setTab(item.id)}
                    role="tab"
                    type="button"
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="tab-panel">
                {tab === "text" ? (
                  <TextPanel
                    page={page}
                    pageCount={textQuery.data?.pageCount ?? detail.pageCount}
                    pages={textQuery.data?.pages ?? null}
                    setPage={setPage}
                  />
                ) : report === null ? (
                  <div className="literature-placeholder compact">尚无解析结果。</div>
                ) : tab === "overview" ? (
                  <OverviewPanel report={report} />
                ) : tab === "checklist" ? (
                  <ChecklistPanel report={report} />
                ) : tab === "route" ? (
                  <RoutePanel report={report} />
                ) : (
                  <InnovationsPanel report={report} />
                )}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function stageLabel(stage: string | null): string {
  switch (stage) {
    case "reading":
      return "正在读取文献…";
    case "analyzing":
      return "正在解析文本…";
    case "mapping":
      return "正在逐段抽取结构与证据…";
    case "reducing":
      return "正在汇总知识清单、技术路线与创新点…";
    case "validating":
      return "正在校验页码引用…";
    default:
      return "正在解析文献…";
  }
}

function ConfidenceBadge({
  item,
}: {
  item: { citationStatus?: string | undefined; confidence?: string | undefined };
}) {
  if (item.citationStatus === "verified")
    return <span className="confidence verified">已核对</span>;
  if (item.citationStatus === "missing")
    return <span className="confidence missing">缺少引用</span>;
  if (item.confidence === "low") return <span className="confidence low">待核对</span>;
  if (item.confidence === "high") return <span className="confidence verified">高置信</span>;
  return null;
}

function EvidenceBlock({ evidence }: { evidence?: string | undefined }) {
  if (evidence === undefined || evidence.trim() === "") return null;
  return (
    <details className="evidence-block">
      <summary>原文证据</summary>
      <q>{evidence}</q>
    </details>
  );
}

function StatusBadge({ status }: { status: LiteratureStatus }) {
  return <span className={`lit-status lit-${status}`}>{STATUS_LABEL[status]}</span>;
}

function PageChips({ pages }: { pages: number[] }) {
  if (pages.length === 0) return null;
  const uniquePages = [...new Set(pages)];
  return (
    <span className="page-chips">
      {uniquePages.map((page) => (
        <span className="page-chip" key={page}>
          p.{page}
        </span>
      ))}
    </span>
  );
}

function OverviewPanel({ report }: { report: LiteratureReport }) {
  return (
    <div className="report-grid">
      <section className="report-card span-2">
        <h3>摘要</h3>
        <Markdown>{report.summary || "模型未给出摘要。"}</Markdown>
        {report.meta !== undefined ? (
          <div className="report-meta">
            <span>
              {report.meta.chunkCount} 个片段 · {report.meta.analyzedPages} 页
            </span>
            <span>{report.meta.model}</span>
            {report.meta.truncated ? (
              <span className="report-meta-warn">原文较长，已截取前部分</span>
            ) : null}
          </div>
        ) : null}
      </section>
      {report.meta?.outline.length ? (
        <section className="report-card">
          <h3>章节结构</h3>
          <ol className="outline-list">
            {report.meta.outline.map((entry) => (
              <li
                className={`outline-item outline-level-${Math.min(entry.level, 3)}`}
                key={`${entry.page}-${entry.title}`}
              >
                <span className="outline-title">{entry.title}</span>
                <span className="page-chip">p.{entry.page}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <section className="report-card">
        <h3>作者</h3>
        <p>{report.authors.length ? report.authors.join("、") : "未识别"}</p>
        <h3>关键词</h3>
        <div className="chip-row">
          {report.keywords.map((keyword) => (
            <span className="chip" key={keyword}>
              {keyword}
            </span>
          ))}
        </div>
      </section>
      <section className="report-card">
        <h3>研究问题</h3>
        <ReportList items={report.researchQuestions} />
      </section>
      <section className="report-card">
        <h3>方法与贡献</h3>
        <ReportList items={report.methods} />
        <ReportList items={report.contributions} />
      </section>
      <section className="report-card">
        <h3>实验</h3>
        <ReportList items={report.experiments} />
      </section>
      <section className="report-card">
        <h3>局限</h3>
        <ReportList items={report.limitations} />
      </section>
    </div>
  );
}

function ChecklistPanel({ report }: { report: LiteratureReport }) {
  if (report.knowledgeChecklist.length === 0) {
    return <div className="literature-placeholder compact">没有知识清单条目。</div>;
  }
  return (
    <div className="checklist">
      {report.knowledgeChecklist.map((item) => (
        <div
          className={`checklist-item importance-${item.importance}`}
          key={`${item.item}-${item.importance}-${item.pages.join("-")}`}
        >
          <span className="importance-dot" />
          <div className="checklist-content">
            <div className="checklist-item-text">{item.item}</div>
            <div className="checklist-meta">
              <span className="importance-label">
                {item.importance === "high"
                  ? "核心"
                  : item.importance === "medium"
                    ? "重要"
                    : "补充"}
              </span>
              <PageChips pages={item.pages} />
              <ConfidenceBadge item={item} />
            </div>
            <EvidenceBlock evidence={item.evidence} />
          </div>
        </div>
      ))}
    </div>
  );
}

function RoutePanel({ report }: { report: LiteratureReport }) {
  if (report.technicalRoute.length === 0) {
    return <div className="literature-placeholder compact">没有识别到技术路线。</div>;
  }
  return (
    <ol className="route">
      {report.technicalRoute.map((step, index) => (
        <li className="route-step" key={`${step.step}-${step.pages.join("-")}`}>
          <span className="route-index">{index + 1}</span>
          <div>
            <div className="route-title">
              {step.step}
              <PageChips pages={step.pages} />
              <ConfidenceBadge item={step} />
            </div>
            <p>{step.description}</p>
            <EvidenceBlock evidence={step.evidence} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function InnovationsPanel({ report }: { report: LiteratureReport }) {
  if (report.innovations.length === 0) {
    return <div className="literature-placeholder compact">没有识别到创新点。</div>;
  }
  return (
    <div className="innovation-grid">
      {report.innovations.map((innovation, index) => (
        <article
          className="innovation-card"
          key={`${innovation.title}-${innovation.pages.join("-")}`}
        >
          <div className="innovation-index">0{index + 1}</div>
          <h3>{innovation.title || "未命名创新点"}</h3>
          <p>{innovation.description}</p>
          <div className="innovation-meta">
            <PageChips pages={innovation.pages} />
            <ConfidenceBadge item={innovation} />
          </div>
          <EvidenceBlock evidence={innovation.evidence} />
        </article>
      ))}
    </div>
  );
}

function TextPanel({
  page,
  pageCount,
  pages,
  setPage,
}: {
  page: number;
  pageCount: number;
  pages: string[] | null;
  setPage: (page: number) => void;
}) {
  const text = pages?.[page - 1];
  return (
    <div className="text-panel">
      <div className="text-toolbar">
        <span>
          第 {page} / {pageCount} 页
        </span>
        <div className="text-nav">
          <button
            className="btn btn-ghost"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
            type="button"
          >
            上一页
          </button>
          <button
            className="btn btn-ghost"
            disabled={page >= pageCount}
            onClick={() => setPage(page + 1)}
            type="button"
          >
            下一页
          </button>
        </div>
      </div>
      {pages === null ? (
        <div className="page-loading">加载全文…</div>
      ) : (
        <pre className="text-content">{text || "（本页没有可提取文字）"}</pre>
      )}
    </div>
  );
}

function ReportList({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="muted">—</p>;
  return (
    <ul className="report-list">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

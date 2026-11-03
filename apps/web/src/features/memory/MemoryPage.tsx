import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Loader2, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { apiFetch } from "../../api/client";
import { memoriesQueryOptions, memorySearchQueryOptions, queryKeys } from "../../api/queries";
import type { MemoryRecord } from "../../api/types";

export function MemoryPage() {
  const queryClient = useQueryClient();
  const memoriesQuery = useQuery(memoriesQueryOptions());
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const searchQuery = useQuery(memorySearchQueryOptions(deferredQuery));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.memories });
  };

  const saveMutation = useMutation({
    mutationFn: (input: { content: string; id?: string; title?: string }) =>
      input.id === undefined
        ? apiFetch<MemoryRecord>("/api/memories", {
            body: JSON.stringify({ content: input.content, title: input.title }),
            method: "POST",
          })
        : apiFetch<MemoryRecord>(`/api/memories/${encodeURIComponent(input.id)}`, {
            body: JSON.stringify({ content: input.content, title: input.title }),
            method: "PATCH",
          }),
    onSuccess: async () => {
      resetForm();
      await refresh();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/memories/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const resetForm = () => {
    setEditingId(null);
    setTitle("");
    setContent("");
    setFormError(null);
  };

  const startEdit = (memory: MemoryRecord) => {
    setEditingId(memory.id);
    setTitle(memory.title);
    setContent(memory.content);
    setFormError(null);
  };

  const submit = async () => {
    if (content.trim() === "") {
      setFormError("请填写记忆内容");
      return;
    }
    setFormError(null);
    try {
      await saveMutation.mutateAsync({
        content: content.trim(),
        ...(editingId === null ? {} : { id: editingId }),
        ...(title.trim() === "" ? {} : { title: title.trim() }),
      });
    } catch (error: unknown) {
      setFormError(error instanceof Error ? error.message : "保存记忆失败");
    }
  };

  const memories = memoriesQuery.data ?? [];
  const results = searchQuery.data ?? [];

  return (
    <div className="memory-page">
      <header className="memory-header">
        <div>
          <h1>长期记忆</h1>
          <p>保存跨会话复用的偏好、约束与稳定事实；检索使用 FTS 与本地向量融合。</p>
        </div>
      </header>

      <div className="memory-layout">
        <section className="memory-editor">
          <div className="memory-editor-head">
            <h2>{editingId === null ? "新增记忆" : "编辑记忆"}</h2>
            {editingId !== null ? (
              <button className="btn btn-ghost" onClick={resetForm} type="button">
                <X size={14} /> 取消
              </button>
            ) : null}
          </div>
          <label className="field">
            <span>标题（可选）</span>
            <input
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例如：项目代码风格"
              value={title}
            />
          </label>
          <label className="field">
            <span>内容</span>
            <textarea
              maxLength={2_000}
              onChange={(event) => setContent(event.target.value)}
              placeholder="保存模型以后应该记住的事实。不要写入密钥或临时对话。"
              rows={8}
              value={content}
            />
          </label>
          {formError !== null ? <div className="inline-error">{formError}</div> : null}
          <button
            className="btn btn-primary"
            disabled={saveMutation.isPending || content.trim() === ""}
            onClick={() => void submit()}
            type="button"
          >
            {saveMutation.isPending ? (
              <Loader2 className="spin" size={14} />
            ) : editingId === null ? (
              <Plus size={14} />
            ) : (
              <Pencil size={14} />
            )}
            {editingId === null ? "保存记忆" : "更新记忆"}
          </button>
        </section>

        <section className="memory-list-panel">
          <div className="memory-search">
            <Search size={15} />
            <input
              aria-label="搜索长期记忆"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索记忆内容…"
              value={query}
            />
            {query !== "" ? (
              <button aria-label="清除搜索" onClick={() => setQuery("")} type="button">
                <X size={14} />
              </button>
            ) : null}
          </div>

          {query.trim() !== "" ? (
            <div className="memory-results">
              {searchQuery.isPending ? (
                <div className="muted-text">搜索中…</div>
              ) : results.length === 0 ? (
                <div className="muted-text">没有匹配的记忆。</div>
              ) : (
                results.map((hit) => (
                  <article className="memory-result" key={hit.chunkId}>
                    <div className="memory-result-title">{hit.documentTitle}</div>
                    <p>{hit.content}</p>
                  </article>
                ))
              )}
            </div>
          ) : null}

          <div className="memory-list">
            {memoriesQuery.isPending ? (
              <div className="muted-text">加载中…</div>
            ) : memories.length === 0 ? (
              <div className="memory-empty">
                <Brain size={24} />
                <p>还没有长期记忆。保存第一条后，Agent 可以通过 `search_memory` 检索。</p>
              </div>
            ) : (
              memories.map((memory) => (
                <article className="memory-card" key={memory.id}>
                  <div className="memory-card-head">
                    <div>
                      <h3>{memory.title}</h3>
                      <div className="memory-card-meta">
                        {new Date(memory.updatedAt).toLocaleString()}
                      </div>
                    </div>
                    <div className="memory-card-actions">
                      <button
                        aria-label="编辑记忆"
                        className="session-action"
                        onClick={() => startEdit(memory)}
                        type="button"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        aria-label="删除记忆"
                        className="session-action"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          if (window.confirm(`删除记忆“${memory.title}”？`)) {
                            deleteMutation.mutate(memory.id);
                          }
                        }}
                        type="button"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                  <p>{memory.content}</p>
                </article>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

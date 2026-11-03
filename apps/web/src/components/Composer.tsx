import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  FileText,
  ImagePlus,
  ListChecks,
  Loader2,
  Paperclip,
  Plus,
  Sparkles,
  Square,
  X,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import { sessionFilesQueryOptions, sessionSkillsQueryOptions } from "../api/queries";
import type { AttachmentView, ChatImage } from "../api/types";

interface PendingDocument {
  file: File;
  id: string;
}

function createPendingDocument(file: File): PendingDocument {
  return {
    file,
    id: globalThis.crypto?.randomUUID?.() ?? `${file.name}-${file.lastModified}-${Math.random()}`,
  };
}

export function Composer({
  controls,
  disabled,
  initialPrompt,
  initialPromptVersion,
  isRunning,
  onSend,
  onSteer,
  onStop,
  onTogglePlanMode,
  placeholder,
  planMode,
  sessionId,
  trailingControls,
}: {
  controls?: ReactNode;
  disabled?: boolean;
  initialPrompt?: string;
  initialPromptVersion?: number;
  isRunning: boolean;
  onSend: (
    text: string,
    images: readonly ChatImage[],
    documentIds: readonly string[],
    files: readonly File[],
  ) => Promise<void>;
  onSteer: (text: string, images: readonly ChatImage[]) => Promise<void>;
  onStop: () => Promise<void>;
  onTogglePlanMode: () => void;
  planMode: boolean;
  placeholder?: string;
  sessionId?: string | undefined;
  trailingControls?: ReactNode;
}) {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<ChatImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [documents, setDocuments] = useState<AttachmentView[]>([]);
  const [pendingDocuments, setPendingDocuments] = useState<PendingDocument[]>([]);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [documentUploading, setDocumentUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [mention, setMention] = useState<{
    end: number;
    query: string;
    start: number;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [skillMention, setSkillMention] = useState<{
    end: number;
    query: string;
    start: number;
  } | null>(null);
  const [skillIndex, setSkillIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const filesQuery = useQuery({
    ...sessionFilesQueryOptions(sessionId ?? "", "."),
    enabled: mention !== null && sessionId !== undefined,
  });
  const mentionCandidates = (filesQuery.data?.entries ?? [])
    .filter((entry) => entry.type === "file")
    .filter((entry) =>
      mention === null
        ? true
        : entry.path.toLocaleLowerCase().includes(mention.query.toLocaleLowerCase()),
    )
    .slice(0, 8);
  const skillsQuery = useQuery({
    ...sessionSkillsQueryOptions(sessionId ?? ""),
    enabled: skillMention !== null && sessionId !== undefined,
  });
  const skillCandidates = (skillsQuery.data ?? [])
    .filter(
      (skill) =>
        skillMention === null ||
        skill.id.includes(skillMention.query.toLowerCase()) ||
        skill.description.toLowerCase().includes(skillMention.query.toLowerCase()),
    )
    .slice(0, 8);

  // biome-ignore lint/correctness/useExhaustiveDependencies: draft 变化时重新计算输入框高度
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 240)}px`;
  }, [draft]);

  const appliedPromptVersion = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (initialPrompt === undefined) return;
    if (
      initialPromptVersion !== undefined &&
      appliedPromptVersion.current === initialPromptVersion
    ) {
      return;
    }
    appliedPromptVersion.current = initialPromptVersion;
    setDraft(initialPrompt);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [initialPrompt, initialPromptVersion]);

  const send = async () => {
    const text = draft.trim();
    if (
      (!text && images.length === 0 && documents.length === 0 && pendingDocuments.length === 0) ||
      sending ||
      disabled === true
    ) {
      return;
    }
    setSending(true);
    try {
      await onSend(
        text,
        images,
        documents.map((document) => document.id),
        pendingDocuments.map((document) => document.file),
      );
      setDraft("");
      setImages([]);
      setDocuments([]);
      setPendingDocuments([]);
    } catch {
      // ChatPage 已展示错误；保留草稿便于重试。
    } finally {
      setSending(false);
    }
  };

  const steer = async () => {
    const text = draft.trim();
    if (documents.length > 0 || pendingDocuments.length > 0) return;
    if ((!text && images.length === 0) || sending || disabled === true) return;
    setSending(true);
    try {
      await onSteer(text, images);
      setDraft("");
      setImages([]);
    } catch {
      // ChatPage 已展示错误；保留草稿便于重试。
    } finally {
      setSending(false);
    }
  };

  const addImages = async (files: FileList | null) => {
    if (files === null) return;
    setImageError(null);
    const additions: ChatImage[] = [];
    let totalBytes = images.reduce((total, image) => total + image.data.length * 0.75, 0);
    for (const file of [...files]) {
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
        setImageError(`不支持的文件类型：${file.name}`);
        continue;
      }
      if (file.size > 700_000) {
        setImageError("单张图片不能超过 700KB");
        continue;
      }
      totalBytes += file.size;
      if (totalBytes > 1_400_000) {
        setImageError("图片总大小不能超过 1.4MB");
        break;
      }
      additions.push({
        data: await readBase64(file),
        mimeType: file.type as ChatImage["mimeType"],
      });
    }
    setImages((current) => [...current, ...additions].slice(0, 4));
  };

  const uploadDocuments = async (files: FileList | null) => {
    if (files === null) return;
    setDocumentError(null);
    if (sessionId === undefined) {
      setPendingDocuments((current) =>
        [...current, ...[...files].map(createPendingDocument)].slice(0, 5),
      );
      return;
    }
    setDocumentUploading(true);
    const uploaded: AttachmentView[] = [];
    try {
      for (const file of [...files]) {
        const form = new FormData();
        form.append("file", file);
        try {
          const attachment = await apiFetch<AttachmentView>(
            `/api/sessions/${encodeURIComponent(sessionId)}/attachments`,
            { body: form, method: "POST" },
          );
          uploaded.push(attachment);
        } catch (error: unknown) {
          setDocumentError(
            error instanceof Error ? `${file.name}: ${error.message}` : `${file.name} 上传失败`,
          );
        }
      }
      setDocuments((current) => [...current, ...uploaded].slice(0, 5));
    } finally {
      setDocumentUploading(false);
    }
  };

  const removeDocument = async (attachment: AttachmentView) => {
    setDocuments((current) => current.filter((item) => item.id !== attachment.id));
    if (sessionId === undefined) return;
    try {
      await apiFetch<void>(
        `/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachment.id)}`,
        { method: "DELETE" },
      );
    } catch {
      // 本地已移除；服务端清理失败不影响当前输入。
    }
  };

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await onStop();
    } finally {
      setStopping(false);
    }
  };

  const insertSkill = (name: string) => {
    if (skillMention === null) return;
    const token = `$${name} `;
    const next = `${draft.slice(0, skillMention.start)}${token}${draft.slice(skillMention.end)}`;
    setDraft(next);
    setSkillMention(null);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea === null) return;
      const position = skillMention.start + token.length;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };

  const insertMention = (path: string) => {
    if (mention === null) return;
    const token = /\s/u.test(path) ? `@"${path}" ` : `@${path} `;
    const next = `${draft.slice(0, mention.start)}${token}${draft.slice(mention.end)}`;
    setDraft(next);
    setMention(null);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea === null) return;
      const position = mention.start + token.length;
      textarea.focus();
      textarea.setSelectionRange(position, position);
    });
  };

  return (
    <div className="composer">
      {skillMention !== null ? (
        <div className="mention-menu">
          {skillsQuery.isPending ? (
            <div className="mention-empty">读取 Skills…</div>
          ) : skillCandidates.length === 0 ? (
            <div className="mention-empty">没有匹配 Skill</div>
          ) : (
            skillCandidates.map((skill, index) => (
              <button
                className={`mention-item${index === skillIndex ? " active" : ""}`}
                key={`${skill.scope}:${skill.id}`}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertSkill(skill.id);
                }}
                onMouseEnter={() => setSkillIndex(index)}
                type="button"
              >
                <Sparkles size={13} />
                <span>
                  ${skill.id}
                  <small className="mention-skill-scope">{skill.scope}</small>
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
      {mention !== null ? (
        <div className="mention-menu">
          {filesQuery.isPending ? (
            <div className="mention-empty">读取工作区文件…</div>
          ) : mentionCandidates.length === 0 ? (
            <div className="mention-empty">没有匹配文件</div>
          ) : (
            mentionCandidates.map((entry, index) => (
              <button
                className={`mention-item${index === mentionIndex ? " active" : ""}`}
                key={entry.path}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertMention(entry.path);
                }}
                onMouseEnter={() => setMentionIndex(index)}
                type="button"
              >
                <FileText size={13} />
                <span>{entry.path}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
      {images.length > 0 ||
      documents.length > 0 ||
      pendingDocuments.length > 0 ||
      imageError !== null ||
      documentError !== null ? (
        <div className="composer-attachments">
          {images.map((image, index) => (
            <div
              className="composer-attachment"
              key={`${image.mimeType}-${image.data.length}-${image.data.slice(-16)}`}
            >
              <img alt={`附件 ${index + 1}`} src={`data:${image.mimeType};base64,${image.data}`} />
              <button
                aria-label={`移除附件 ${index + 1}`}
                onClick={() => setImages((current) => current.filter((_, i) => i !== index))}
                type="button"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {documents.map((document) => (
            <span className="composer-doc" key={document.id}>
              <FileText size={12} />
              <span>{document.fileName}</span>
              <button
                aria-label={`移除附件 ${document.fileName}`}
                onClick={() => void removeDocument(document)}
                type="button"
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {pendingDocuments.map((document) => (
            <span className="composer-doc" key={document.id}>
              <FileText size={12} />
              <span>{document.file.name}</span>
              <button
                aria-label={`移除附件 ${document.file.name}`}
                onClick={() =>
                  setPendingDocuments((current) =>
                    current.filter((item) => item.id !== document.id),
                  )
                }
                type="button"
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {imageError !== null ? <span className="composer-image-error">{imageError}</span> : null}
          {documentError !== null ? (
            <span className="composer-image-error">{documentError}</span>
          ) : null}
        </div>
      ) : null}
      <textarea
        aria-label="消息输入"
        className="composer-input"
        disabled={disabled === true}
        onChange={(event) => {
          const value = event.target.value;
          const caret = event.target.selectionStart ?? value.length;
          setDraft(value);
          const match = /(?:^|\s)@([^\s@]*)$/u.exec(value.slice(0, caret));
          if (match !== null) {
            const query = match[1] ?? "";
            setMention({ end: caret, query, start: caret - query.length - 1 });
            setMentionIndex(0);
            setSkillMention(null);
            return;
          }
          setMention(null);
          const skillMatch = /(?:^|\s)\$([a-z0-9-]*)$/iu.exec(value.slice(0, caret));
          if (skillMatch === null) {
            setSkillMention(null);
            return;
          }
          const skillQuery = skillMatch[1] ?? "";
          setSkillMention({
            end: caret,
            query: skillQuery,
            start: caret - skillQuery.length - 1,
          });
          setSkillIndex(0);
        }}
        onBlur={() =>
          window.setTimeout(() => {
            setMention(null);
            setSkillMention(null);
          }, 120)
        }
        onKeyDown={(event) => {
          if (skillMention !== null && skillCandidates.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSkillIndex((index) => (index + 1) % skillCandidates.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setSkillIndex(
                (index) => (index - 1 + skillCandidates.length) % skillCandidates.length,
              );
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              const candidate = skillCandidates[skillIndex];
              if (candidate !== undefined) {
                event.preventDefault();
                insertSkill(candidate.id);
                return;
              }
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setSkillMention(null);
              return;
            }
          }
          if (mention !== null && mentionCandidates.length > 0) {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setMentionIndex((index) => (index + 1) % mentionCandidates.length);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setMentionIndex(
                (index) => (index - 1 + mentionCandidates.length) % mentionCandidates.length,
              );
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              const candidate = mentionCandidates[mentionIndex];
              if (candidate !== undefined) {
                event.preventDefault();
                insertMention(candidate.path);
                return;
              }
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setMention(null);
              return;
            }
          }
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          if ((event.metaKey || event.ctrlKey) && isRunning) {
            event.preventDefault();
            void steer();
            return;
          }
          if (!event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
        placeholder={placeholder ?? "给 Agent 发消息…"}
        ref={textareaRef}
        rows={1}
        value={draft}
      />
      <div className="composer-actions">
        <div className="composer-leading">
          <div className="composer-add-wrap">
            <button
              aria-expanded={addMenuOpen}
              aria-haspopup="menu"
              aria-label="添加文件等内容"
              className={`composer-button attach composer-add${planMode ? " active" : ""}`}
              disabled={disabled === true}
              onClick={() => setAddMenuOpen((value) => !value)}
              title="添加附件或切换计划模式"
              type="button"
            >
              {documentUploading ? <Loader2 className="spin" size={13} /> : <Plus size={15} />}
            </button>
            <input
              accept=".pdf,.docx,.pptx,.xlsx,.xls,.txt,.md,.markdown,.csv"
              className="hidden-input"
              multiple
              onChange={(event) => {
                void uploadDocuments(event.target.files);
                event.target.value = "";
              }}
              ref={documentInputRef}
              type="file"
            />
            <input
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden-input"
              multiple
              onChange={(event) => {
                void addImages(event.target.files);
                event.target.value = "";
              }}
              ref={fileInputRef}
              type="file"
            />
            {addMenuOpen ? (
              <>
                <button
                  aria-label="关闭添加菜单"
                  className="composer-add-backdrop"
                  onClick={() => setAddMenuOpen(false)}
                  type="button"
                />
                <div className="composer-add-menu" role="menu">
                  <button
                    disabled={documentUploading || sending}
                    onClick={() => {
                      setAddMenuOpen(false);
                      documentInputRef.current?.click();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <Paperclip size={11} />
                    添加文档
                  </button>
                  <button
                    disabled={sending}
                    onClick={() => {
                      setAddMenuOpen(false);
                      fileInputRef.current?.click();
                    }}
                    role="menuitem"
                    type="button"
                  >
                    <ImagePlus size={11} />
                    添加图片
                  </button>
                  <button
                    aria-checked={planMode}
                    disabled={isRunning}
                    onClick={() => {
                      setAddMenuOpen(false);
                      onTogglePlanMode();
                    }}
                    role="menuitemcheckbox"
                    type="button"
                  >
                    <ListChecks size={11} />
                    {planMode ? "退出计划模式" : "计划模式"}
                  </button>
                </div>
              </>
            ) : null}
          </div>
          {controls === undefined ? (
            <span className="composer-hint">
              {planMode
                ? "计划模式：只读分析，不执行写文件/命令"
                : isRunning
                  ? "Enter 排队；⌘/Ctrl+Enter 插话 · 输入 @ 引用文件 / $ 引用 Skill"
                  : "输入 @ 引用文件 · $ 引用 Skill · 工具执行前会请求批准"}
            </span>
          ) : (
            <div className="composer-controls">{controls}</div>
          )}
        </div>
        <div className="composer-trailing">
          {trailingControls === undefined ? null : (
            <div className="composer-controls">{trailingControls}</div>
          )}
          <div className="composer-buttons">
            {isRunning ? (
              <button
                aria-label="插话"
                className="composer-button steer"
                disabled={
                  (draft.trim().length === 0 && images.length === 0) || sending || disabled === true
                }
                onClick={() => void steer()}
                type="button"
              >
                <Zap size={11} />
                插话
              </button>
            ) : null}
            {isRunning ? (
              <button
                aria-label="停止运行"
                className="composer-button stop"
                disabled={stopping}
                onClick={() => void stop()}
                type="button"
              >
                <Square size={11} />
                {stopping ? "停止中" : "停止"}
              </button>
            ) : null}
            <button
              aria-label={planMode ? "生成计划" : isRunning ? "排队发送" : "发送消息"}
              className="composer-button send"
              disabled={
                (draft.trim().length === 0 &&
                  images.length === 0 &&
                  documents.length === 0 &&
                  pendingDocuments.length === 0) ||
                sending ||
                disabled === true
              }
              onClick={() => void send()}
              type="button"
            >
              <ArrowUp size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.readAsDataURL(file);
  });
}

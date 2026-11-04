import { FileCode } from "lucide-react";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { parseLocalPathRef } from "./local-path";
import { normalizeMathDelimiters } from "./math-delimiters";
import { RichCodeBlock } from "./RichCodeBlock";

/**
 * 只在行内代码里识别本地路径。普通正文里的路径形态太容易和命令、URL 混淆，
 * 误判的代价比漏判高得多。
 */
function LocalPathChip({ path }: { path: string }) {
  const reveal = window.fathom?.workspace?.reveal;
  // 相对路径没法直接交给系统打开，只有绝对路径才做成可点击。
  const clickable = reveal !== undefined && /^[A-Za-z]:[\\/]/u.test(path);
  const content = (
    <>
      <FileCode size={12} />
      {path}
    </>
  );
  if (!clickable) {
    return (
      <span className="local-path" title={path}>
        {content}
      </span>
    );
  }
  return (
    <button
      className="local-path local-path-clickable"
      onClick={() => void reveal(path)}
      title={path}
      type="button"
    >
      {content}
    </button>
  );
}

export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        rehypePlugins={[rehypeKatex]}
        remarkPlugins={[remarkGfm, remarkMath]}
        components={{
          a: ({ children: linkChildren, href }) => (
            <a href={href} rel="noopener noreferrer" target="_blank">
              {linkChildren}
            </a>
          ),
          code: ({ children: codeChildren, className }) => {
            const isBlock = typeof className === "string" && className.startsWith("language-");
            if (isBlock) return <code className={className}>{codeChildren}</code>;
            const text = typeof codeChildren === "string" ? codeChildren : null;
            const reference = text === null ? null : parseLocalPathRef(text);
            if (reference !== null && reference.kind === "file") {
              return <LocalPathChip path={reference.path} />;
            }
            return <code className="inline-code">{codeChildren}</code>;
          },
          pre: ({ children: preChildren }) => <RichCodeBlock>{preChildren}</RichCodeBlock>,
          table: ({ children: tableChildren }) => (
            <div className="table-wrap">
              <table>{tableChildren}</table>
            </div>
          ),
        }}
      >
        {normalizeMathDelimiters(children)}
      </ReactMarkdown>
    </div>
  );
});

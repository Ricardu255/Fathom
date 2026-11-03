import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { normalizeMathDelimiters } from "./math-delimiters";
import { RichCodeBlock } from "./RichCodeBlock";

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
            return isBlock ? (
              <code className={className}>{codeChildren}</code>
            ) : (
              <code className="inline-code">{codeChildren}</code>
            );
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

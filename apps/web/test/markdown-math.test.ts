import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import { normalizeMathDelimiters } from "../src/components/math-delimiters";

test("将论文的 \\(...\\) / \\[...\\] 转为 remark-math 分隔符", () => {
  assert.equal(
    normalizeMathDelimiters("公式 \\(T_i = S_i \\odot t_i\\)"),
    "公式 $T_i = S_i \\odot t_i$",
  );
  assert.match(
    normalizeMathDelimiters("\\[T_i = \\sum_k Conv1D_k(S_i)\\]"),
    /\$\$\nT_i = \\sum_k Conv1D_k\(S_i\)\n\$\$/u,
  );
});

test("代码块和行内代码中的反斜杠不被改写", () => {
  const source = "`\\\\(x\\\\)`\n\n```tex\n\\\\(x\\\\)\n```";
  assert.equal(normalizeMathDelimiters(source), source);
});

test("KaTeX 能把转换后的公式渲染成 HTML", (t) => {
  const source = normalizeMathDelimiters(String.raw`\(T_i = \sum_k Conv1D_k(S_i)\)`);
  const html = renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        rehypePlugins: [rehypeKatex],
        remarkPlugins: [remarkMath],
      },
      source,
    ),
  );
  assert.match(html, /class="katex"/u);
  t.diagnostic(html.slice(0, 180));
});

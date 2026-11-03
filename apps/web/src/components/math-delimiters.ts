const CODE_SPAN_PATTERN = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/gu;
const DISPLAY_MATH = /\\\[([\s\S]+?)\\\]/gu;
const INLINE_MATH = /\\\(([\s\S]+?)\\\)/gu;

/**
 * 论文和模型经常输出 \(...\) / \[...\]，而 remark-math 只识别 $...$。
 * 仅在非代码片段中转换，避免改动代码块里的反斜杠。
 */
export function normalizeMathDelimiters(source: string): string {
  return source
    .split(CODE_SPAN_PATTERN)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      return part
        .replace(DISPLAY_MATH, (_match, body: string) => `\n$$\n${body.trim()}\n$$\n`)
        .replace(INLINE_MATH, (_match, body: string) => `$${body.trim()}$`);
    })
    .join("");
}

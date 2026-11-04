const MAX_TITLE_LENGTH = 40;
/** 只把开头这一段喂给模型，标题不需要整段历史。 */
const MAX_PROMPT_CHARS = 2_000;

/** 模型没给出可用标题时的回退：首条输入压成一行，取前 40 个字符。 */
export function fallbackSessionTitle(prompt: string): string {
  return prompt.replace(/\s+/gu, " ").trim().slice(0, MAX_TITLE_LENGTH);
}

/**
 * 模型经常带上引号、`标题：` 前缀或额外解释。只取第一行有内容的文本，
 * 剥掉这些包装；清洗后为空就当作没生成成功，交给调用方回退。
 */
export function sanitizeGeneratedTitle(raw: string): string | null {
  const line = raw
    .split("\n")
    .map((item) => item.trim())
    .find((item) => item !== "");
  if (line === undefined) return null;
  const cleaned = line
    .replace(/^(?:标题|title)\s*[:：]\s*/iu, "")
    .replace(/^["'「『]+/u, "")
    .replace(/["'」』]+$/u, "")
    .replace(/\s+/gu, " ")
    .replace(/[。．.]+$/u, "")
    .trim();
  return cleaned === "" ? null : cleaned.slice(0, MAX_TITLE_LENGTH);
}

export function buildTitlePrompt(prompt: string): string {
  return `为下面这段对话起一个标题。要求：不超过 20 个汉字或 40 个字符，只输出标题本身，不要引号、句号或任何解释。\n\n${prompt.slice(
    0,
    MAX_PROMPT_CHARS,
  )}`;
}

/** 从 pi 的 AssistantMessage 里取纯文本；出错时当作没有内容。 */
export function assistantText(result: { content?: unknown; errorMessage?: unknown }): string {
  if (typeof result.errorMessage === "string" && result.errorMessage !== "") return "";
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("");
}

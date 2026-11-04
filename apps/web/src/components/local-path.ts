const IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "svg", "webp"]);
const EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,8}$/u;
const WINDOWS_ABSOLUTE_PATTERN = /^[A-Za-z]:[\\/]/u;
const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const URL_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;
/** 空白和 shell 元字符出现在路径里，基本可以断定是命令或普通句子。 */
const INVALID_PATTERN = /[\s*?<>|"']/u;
const MAX_PATH_LENGTH = 400;

export interface LocalPathRef {
  kind: "file" | "image";
  path: string;
}

/**
 * 只认「看起来像路径」的东西，宁可漏判也不要误判：
 * 把一句话或一条命令渲染成文件链接，比不渲染更糟。
 *
 * 采纳条件：绝对路径（盘符、/、./、../）或带扩展名的相对路径。
 */
export function parseLocalPathRef(input: string): LocalPathRef | null {
  const raw = input.trim();
  if (raw === "" || raw.length > MAX_PATH_LENGTH) return null;
  if (URL_PATTERN.test(raw)) return null;
  if (INVALID_PATTERN.test(raw)) return null;
  // `npm:`、`C:` 这类 scheme 前缀要排除，但 Windows 盘符要保留。
  if (SCHEME_PATTERN.test(raw) && !WINDOWS_ABSOLUTE_PATTERN.test(raw)) return null;

  const isAbsolute =
    WINDOWS_ABSOLUTE_PATTERN.test(raw) ||
    raw.startsWith("/") ||
    raw.startsWith("./") ||
    raw.startsWith("../");
  const hasExtension = EXTENSION_PATTERN.test(raw);
  if (!isAbsolute && !hasExtension) return null;
  // 相对路径至少要有分隔符或扩展名，避免把 `README` 这种普通词当成文件。
  if (!isAbsolute && !raw.includes("/") && !raw.includes("\\") && !hasExtension) return null;

  const extension = raw.split(".").pop()?.toLowerCase() ?? "";
  return {
    kind: IMAGE_EXTENSIONS.has(extension) ? "image" : "file",
    path: raw,
  };
}

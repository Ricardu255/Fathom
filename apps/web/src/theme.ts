export type ThemeMode = "dark" | "light" | "system";

const STORAGE_KEY = "harness-theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function getThemeMode(): ThemeMode {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "dark" || stored === "light" || stored === "system" ? stored : "light";
}

export function setThemeMode(mode: ThemeMode): void {
  window.localStorage.setItem(STORAGE_KEY, mode);
  applyTheme(mode);
}

export function initializeTheme(): void {
  const mode = getThemeMode();
  applyTheme(mode);
  const media = window.matchMedia(MEDIA_QUERY);
  const onChange = () => {
    if (getThemeMode() === "system") applyTheme("system");
  };
  media.addEventListener("change", onChange);
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) applyTheme(getThemeMode());
  });
}

function applyTheme(mode: ThemeMode): void {
  const resolved =
    mode === "system" ? (window.matchMedia(MEDIA_QUERY).matches ? "dark" : "light") : mode;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

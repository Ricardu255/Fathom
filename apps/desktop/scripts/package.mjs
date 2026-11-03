import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const env = { ...process.env };
const args = [...process.argv.slice(2)];

// 优先使用本地 Electron，避免打包时从 GitHub 重新下载。
const electronDist = join(desktopRoot, "node_modules", "electron", "dist");
const electronBinary =
  process.platform === "win32"
    ? join(electronDist, "electron.exe")
    : process.platform === "darwin"
      ? join(electronDist, "Electron.app")
      : join(electronDist, "electron");
if (existsSync(electronBinary)) {
  args.push(`--config.electronDist=${electronDist}`);
}

// 网络受限时复用 electron-builder 已解压的 NSIS 工具链。
const cacheRoot =
  process.env.ELECTRON_BUILDER_CACHE ??
  (process.platform === "win32"
    ? join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "electron-builder",
        "Cache",
      )
    : process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "electron-builder")
      : join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "electron-builder"));
const nsisRoot = join(cacheRoot, "nsis");
if (existsSync(nsisRoot)) {
  const directories = readdirSync(nsisRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const nsisDir = directories.find(
    (name) =>
      name.startsWith("nsis-3.0.4.1-") &&
      (existsSync(join(nsisRoot, name, "Bin", "makensis.exe")) ||
        existsSync(join(nsisRoot, name, "makensis.cmd"))),
  );
  if (nsisDir !== undefined) env.ELECTRON_BUILDER_NSIS_DIR = join(nsisRoot, nsisDir);
  const resourcesDir = directories.find(
    (name) =>
      name.startsWith("nsis-resources-3.4.1-") &&
      (existsSync(join(nsisRoot, name, "plugins")) ||
        existsSync(join(nsisRoot, name, "windows", "Plugins"))),
  );
  if (resourcesDir !== undefined) {
    env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR = join(nsisRoot, resourcesDir);
  }
}

const cliCandidates = [
  join(desktopRoot, "node_modules", "electron-builder", "cli.js"),
  join(repoRoot, "node_modules", "electron-builder", "cli.js"),
];
const cli = cliCandidates.find((candidate) => existsSync(candidate));
if (cli === undefined) {
  console.error("未找到 electron-builder，请先运行 pnpm install");
  process.exit(1);
}

const result = spawnSync(process.execPath, [cli, ...args], {
  cwd: desktopRoot,
  env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);

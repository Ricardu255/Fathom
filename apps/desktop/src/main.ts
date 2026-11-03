import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { OpenDialogOptions } from "electron";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import {
  buildDaemonEnv,
  createDesktopToken,
  decideLink,
  findFreePort,
  resolveDesktopPaths,
  waitForHealth,
} from "./runtime";
import {
  defaultStoragePaths,
  isPathInside,
  prepareStorage,
  readStorageConfig,
  type StoragePaths,
  writeStorageConfig,
} from "./storage";

const APP_NAME = "Fathom";
const DEBUG_LOG = process.env.FATHOM_DEBUG_LOG;

function earlyLog(message: string): void {
  if (DEBUG_LOG === undefined) return;
  try {
    appendFileSync(
      DEBUG_LOG,
      `${new Date().toISOString()} ${message}
`,
    );
  } catch {
    // 调试日志失败不影响启动。
  }
}

earlyLog("main module loaded");
const gotLock = app.requestSingleInstanceLock();
earlyLog(`single instance lock=${gotLock}`);
if (!gotLock) {
  app.quit();
} else {
  app.setName(APP_NAME);
  app.setPath("userData", join(app.getPath("appData"), APP_NAME));
  app.setAppUserModelId("com.fathom.harness");

  const userData = app.getPath("userData");
  const initialStorage = readStorageConfig(userData);
  const initialCacheDir = initialStorage.cacheDir ?? defaultStoragePaths(userData).cacheDir;
  try {
    mkdirSync(initialCacheDir, { recursive: true });
    app.setPath("cache", initialCacheDir);
  } catch {
    // 缓存目录不可用时继续使用 Electron 默认路径。
  }

  let mainWindow: BrowserWindow | null = null;
  let daemon: ChildProcess | null = null;
  let serverOrigin: string | null = null;
  let activeStorage: StoragePaths | null = null;
  const desktopToken = createDesktopToken();

  function log(message: string): void {
    earlyLog(message);
    try {
      const directory = join(initialCacheDir, "logs");
      mkdirSync(directory, { recursive: true });
      appendFileSync(
        join(directory, "desktop.log"),
        `${new Date().toISOString()} ${message}
`,
      );
    } catch {
      // 日志失败不影响启动。
    }
  }

  process.on("uncaughtException", (error) => {
    log(`uncaught: ${error.stack ?? error.message}`);
  });
  let daemonLog = "";
  let quitting = false;

  app.on("second-instance", () => {
    if (mainWindow === null) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (process.platform !== "darwin") Menu.setApplicationMenu(null);
    registerStorageIpc();
    try {
      await launch();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox(`${APP_NAME} 启动失败`, `${message}\n\n${daemonLog.slice(-4_000)}`);
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (mainWindow === null && daemon !== null) void createWindow();
  });

  app.on("before-quit", () => {
    quitting = true;
    stopDaemon();
  });

  async function launch(): Promise<void> {
    log("launch start");
    const storage = prepareStorage(userData);
    activeStorage = storage;
    if (storage.migrationError !== null) {
      log(`data migration failed: ${storage.migrationError}`);
      dialog.showErrorBox("数据迁移失败", `将继续使用原数据目录。\n\n${storage.migrationError}`);
    }
    const repoRoot = app.isPackaged ? process.resourcesPath : join(__dirname, "..", "..", "..");
    const paths = resolveDesktopPaths({
      cacheDir: storage.cacheDir,
      dataDir: storage.dataDir,
      isPackaged: app.isPackaged,
      repoRoot,
      resourcesPath: process.resourcesPath,
      userData,
    });
    const port = await findFreePort();
    log(`paths ${JSON.stringify(paths)} port=${port}`);
    const origin = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      ...buildDaemonEnv({
        dataDir: paths.dataDir,
        desktopToken,
        port,
        webDist: paths.webDist,
        workspace: paths.workspace,
      }),
      ELECTRON_RUN_AS_NODE: "1",
    };
    log(`spawning daemon ${paths.daemonEntry}`);
    daemon = spawn(process.execPath, [paths.daemonEntry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    daemon.stdout?.on("data", (chunk: Buffer) => appendLog(chunk.toString("utf8")));
    daemon.stderr?.on("data", (chunk: Buffer) => appendLog(chunk.toString("utf8")));
    daemon.once("exit", (code) => {
      log(`daemon exit ${code}`);
      daemon = null;
      if (quitting) return;
      if (mainWindow !== null) {
        dialog.showErrorBox(
          `${APP_NAME} 服务已停止`,
          `daemon 退出码：${code ?? "unknown"}\n\n${daemonLog.slice(-4_000)}`,
        );
      }
    });
    await waitForHealth(origin);
    log("daemon healthy");
    serverOrigin = origin;
    await createWindow();
  }

  function registerStorageIpc(): void {
    ipcMain.handle("fathom:storage:get", () => storageInfo());
    ipcMain.handle("fathom:storage:choose-data", () => chooseDataDirectory());
    ipcMain.handle("fathom:storage:choose-cache", () => chooseCacheDirectory());
    ipcMain.handle("fathom:storage:open-data", () => openStorageFolder("data"));
    ipcMain.handle("fathom:storage:open-cache", () => openStorageFolder("cache"));
    ipcMain.handle("fathom:storage:restart", () => {
      restartApplication();
    });
    ipcMain.handle("fathom:workspace:choose", () => chooseDirectory("选择 Fathom 工作区目录"));
    ipcMain.handle("fathom:workspace:reveal", async (_event, pathValue: unknown) => {
      if (typeof pathValue !== "string" || !isAbsolute(pathValue)) {
        throw new Error("无效的工作区路径");
      }
      const info = await stat(pathValue).catch(() => null);
      if (info === null) throw new Error("工作区目录不存在");
      if (info.isDirectory()) {
        const error = await shell.openPath(pathValue);
        if (error !== "") throw new Error(error);
      } else {
        shell.showItemInFolder(pathValue);
      }
    });
  }

  function storageInfo(): {
    cacheDir: string;
    configuredCacheDir: string;
    configuredDataDir: string;
    dataDir: string;
    migrationPending: boolean;
  } {
    const config = readStorageConfig(userData);
    const defaults = defaultStoragePaths(userData);
    const active = activeStorage ?? {
      cacheDir: config.cacheDir ?? defaults.cacheDir,
      dataDir: config.dataDir ?? defaults.dataDir,
      migrationError: null,
    };
    const configuredDataDir = config.dataDir ?? active.dataDir;
    const configuredCacheDir = config.cacheDir ?? active.cacheDir;
    return {
      cacheDir: active.cacheDir,
      configuredCacheDir,
      configuredDataDir,
      dataDir: active.dataDir,
      migrationPending:
        config.migrateDataFrom !== undefined ||
        configuredDataDir !== active.dataDir ||
        configuredCacheDir !== active.cacheDir,
    };
  }

  async function chooseDirectory(title: string): Promise<string | null> {
    const options: OpenDialogOptions = {
      properties: ["openDirectory", "createDirectory"],
      title,
    };
    const result =
      mainWindow === null
        ? await dialog.showOpenDialog(options)
        : await dialog.showOpenDialog(mainWindow, options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }

  async function chooseDataDirectory(): Promise<{
    canceled?: boolean;
    changed?: boolean;
    error?: string;
    restartRequired?: boolean;
  }> {
    const selected = await chooseDirectory("选择 Fathom 数据目录");
    if (selected === null) return { canceled: true };
    const target = resolve(selected);
    const current = activeStorage?.dataDir ?? storageInfo().dataDir;
    if (target === current) return { canceled: false, changed: false };
    if (isPathInside(current, target) || isPathInside(target, current)) {
      return { canceled: false, error: "数据目录不能与当前数据目录互相嵌套" };
    }

    const empty = !existsSync(target) || readdirSync(target).length === 0;
    if (!empty) {
      const confirmation =
        mainWindow === null
          ? await dialog.showMessageBox({
              buttons: ["使用现有目录", "取消"],
              cancelId: 1,
              defaultId: 0,
              detail: "目标目录已有内容。将直接使用其中的现有数据，当前数据不会迁移。",
              message: "目标目录不是空的",
              type: "question",
            })
          : await dialog.showMessageBox(mainWindow, {
              buttons: ["使用现有目录", "取消"],
              cancelId: 1,
              defaultId: 0,
              detail: "目标目录已有内容。将直接使用其中的现有数据，当前数据不会迁移。",
              message: "目标目录不是空的",
              type: "question",
            });
      if (confirmation.response !== 0) return { canceled: true };
    }

    const config = readStorageConfig(userData);
    const next = { ...config, dataDir: target };
    if (empty) next.migrateDataFrom = current;
    else delete next.migrateDataFrom;
    writeStorageConfig(userData, next);
    return { canceled: false, changed: true, restartRequired: true };
  }

  async function chooseCacheDirectory(): Promise<{
    canceled?: boolean;
    changed?: boolean;
    error?: string;
    restartRequired?: boolean;
  }> {
    const selected = await chooseDirectory("选择 Fathom 缓存目录");
    if (selected === null) return { canceled: true };
    const target = resolve(selected);
    const info = storageInfo();
    if (target === info.cacheDir) return { canceled: false, changed: false };
    if (isPathInside(info.dataDir, target) || isPathInside(target, info.dataDir)) {
      return { canceled: false, error: "缓存目录不能与数据目录重叠" };
    }
    const config = readStorageConfig(userData);
    writeStorageConfig(userData, { ...config, cacheDir: target });
    return { canceled: false, changed: true, restartRequired: true };
  }

  async function openStorageFolder(kind: "cache" | "data"): Promise<void> {
    const info = storageInfo();
    const target = kind === "data" ? info.dataDir : info.cacheDir;
    const error = await shell.openPath(target);
    if (error !== "") throw new Error(error);
  }

  async function createWindow(): Promise<void> {
    if (serverOrigin === null) throw new Error("daemon origin 尚未就绪");
    const origin = serverOrigin;
    mainWindow = new BrowserWindow({
      backgroundColor: "#fbf9f4",
      height: 860,
      minHeight: 640,
      minWidth: 1000,
      show: false,
      title: APP_NAME,
      titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
      ...(process.platform === "darwin"
        ? {}
        : {
            titleBarOverlay: {
              color: "#fbf9f4",
              height: 48,
              symbolColor: "#1e2748",
            },
          }),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(__dirname, "preload.js"),
        sandbox: true,
      },
      width: 1360,
    });
    mainWindow.once("ready-to-show", () => mainWindow?.show());
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      const decision = decideLink(url, origin);
      if (decision.action === "external") void shell.openExternal(decision.url);
      return decision.action === "allow" ? { action: "allow" } : { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
      const decision = decideLink(url, origin);
      if (decision.action === "allow") return;
      event.preventDefault();
      if (decision.action === "external") void shell.openExternal(decision.url);
    });
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      log(`renderer gone ${JSON.stringify(details)}`);
    });
    mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
      log(`did-fail-load ${code} ${description}`);
    });
    await mainWindow.loadURL(origin);
    log("window loaded");
  }

  function appendLog(text: string): void {
    daemonLog = `${daemonLog}${text}`.slice(-64 * 1024);
    if (!app.isPackaged) process.stdout.write(text);
  }

  function stopDaemon(): void {
    if (daemon === null) return;
    const child = daemon;
    daemon = null;
    terminateDaemon(child);
  }

  function terminateDaemon(child: ChildProcess): void {
    try {
      if (process.platform === "win32" && child.pid !== undefined) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      // 已退出。
    }
  }

  /**
   * 优先让 daemon 自己收尾。直接 taskkill 会打断进行中的 SQLite/JSONL 写入，
   * 而重启路径后面紧跟着数据目录迁移，正是最怕写坏的时刻。
   * 拿不到令牌或请求失败时由调用方回退到硬杀。
   */
  async function requestGracefulShutdown(): Promise<boolean> {
    const origin = serverOrigin;
    if (origin === null) return false;
    try {
      const response = await fetch(`${origin}/__desktop/shutdown`, {
        headers: {
          origin,
          "x-fathom-desktop-token": desktopToken,
          "x-harness-request": "1",
        },
        method: "POST",
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** 等 daemon 退出后再重启，避免迁移数据时仍有 SQLite/JSONL 写入。 */
  function restartApplication(): void {
    quitting = true;
    const relaunch = () => {
      app.relaunch();
      app.exit(0);
    };
    if (daemon === null) {
      relaunch();
      return;
    }
    const child = daemon;
    daemon = null;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      relaunch();
    };
    timer = setTimeout(finish, 5_000);
    child.once("exit", finish);
    void requestGracefulShutdown().then((ok) => {
      if (!ok) terminateDaemon(child);
    });
  }
}

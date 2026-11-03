import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";

export interface DesktopPaths {
  cacheDir: string;
  daemonEntry: string;
  dataDir: string;
  webDist: string;
  workspace: string;
}

export type LinkDecision =
  | { action: "allow" }
  | { action: "deny" }
  | { action: "external"; url: string };

/** 只有 http/https 能交给系统浏览器；file、smb、自定义 scheme 一律不接手。 */
export function parseExternalUrl(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 应用内窗口只认 daemon 自己的 origin。其余 http(s) 交给系统浏览器，别的协议直接拒绝：
 * 把未知 scheme 递给 shell.openExternal，等于把「用什么程序打开」的决定权交给页面。
 */
export function decideLink(url: string, daemonOrigin: string): LinkDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { action: "deny" };
  }
  try {
    if (parsed.origin === new URL(daemonOrigin).origin) return { action: "allow" };
  } catch {
    return { action: "deny" };
  }
  const external = parseExternalUrl(url);
  return external === null ? { action: "deny" } : { action: "external", url: external };
}

/** 每次启动重新生成，用来区分「桌面壳发来的请求」和「本机其他进程」。 */
export function createDesktopToken(): string {
  return randomBytes(32).toString("hex");
}

export function resolveDesktopPaths(input: {
  cacheDir?: string;
  dataDir?: string;
  isPackaged: boolean;
  resourcesPath: string;
  repoRoot: string;
  userData: string;
}): DesktopPaths {
  const defaults = input.isPackaged
    ? {
        dataDir: join(input.userData, "data"),
        workspace: join(input.userData, "workspace"),
      }
    : {
        dataDir: join(input.repoRoot, ".desktop-data"),
        workspace: join(input.repoRoot, ".desktop-workspace"),
      };
  const cacheDir = input.cacheDir ?? join(input.userData, "cache");
  const dataDir = input.dataDir ?? defaults.dataDir;
  if (input.isPackaged) {
    return {
      cacheDir,
      daemonEntry: join(input.resourcesPath, "daemon.mjs"),
      dataDir,
      webDist: join(input.resourcesPath, "web"),
      workspace: defaults.workspace,
    };
  }
  return {
    cacheDir,
    daemonEntry: join(input.repoRoot, "apps", "desktop", "resources", "daemon.mjs"),
    dataDir,
    webDist: join(input.repoRoot, "apps", "desktop", "resources", "web"),
    workspace: defaults.workspace,
  };
}

export function buildDaemonEnv(input: {
  dataDir: string;
  desktopToken?: string;
  port: number;
  webDist: string;
  workspace: string;
}): Record<string, string> {
  const origin = `http://127.0.0.1:${input.port}`;
  return {
    HARNESS_DATA_DIR: input.dataDir,
    HARNESS_DESKTOP_TOKEN: input.desktopToken ?? "",
    HARNESS_ENGINE: "pi",
    HARNESS_HOST: "127.0.0.1",
    HARNESS_PORT: String(input.port),
    HARNESS_WEB_DIST: input.webDist,
    HARNESS_WEB_ORIGIN: origin,
    HARNESS_WORKSPACE: input.workspace,
  };
}

export async function findFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("无法分配本地端口"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error !== undefined) reject(error);
        else resolve(port);
      });
    });
  });
}

export async function waitForHealth(
  origin: string,
  input: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 20_000);
  const interval = input.intervalMs ?? 200;
  for (;;) {
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // daemon 尚未监听。
    }
    if (Date.now() >= deadline) {
      throw new Error(`daemon 启动超时：${origin}`);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

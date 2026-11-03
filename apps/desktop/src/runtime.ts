import { createServer } from "node:net";
import { join } from "node:path";

export interface DesktopPaths {
  cacheDir: string;
  daemonEntry: string;
  dataDir: string;
  webDist: string;
  workspace: string;
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
  port: number;
  webDist: string;
  workspace: string;
}): Record<string, string> {
  const origin = `http://127.0.0.1:${input.port}`;
  return {
    HARNESS_DATA_DIR: input.dataDir,
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

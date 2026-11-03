import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { buildDaemonEnv, findFreePort, resolveDesktopPaths, waitForHealth } from "../src/runtime";

test("桌面环境变量固定为回环地址并指向客户端资源", () => {
  const env = buildDaemonEnv({
    dataDir: "/tmp/data",
    port: 4321,
    webDist: "/tmp/web",
    workspace: "/tmp/workspace",
  });
  assert.equal(env.HARNESS_HOST, "127.0.0.1");
  assert.equal(env.HARNESS_PORT, "4321");
  assert.equal(env.HARNESS_WEB_ORIGIN, "http://127.0.0.1:4321");
  assert.equal(env.HARNESS_WEB_DIST, "/tmp/web");
});

test("打包/开发路径解析", () => {
  const packaged = resolveDesktopPaths({
    isPackaged: true,
    repoRoot: "D:/repo",
    resourcesPath: "C:/Program Files/Fathom/resources",
    userData: "C:/Users/me/AppData/Fathom",
  });
  assert.equal(packaged.daemonEntry, join("C:/Program Files/Fathom/resources", "daemon.mjs"));
  assert.equal(packaged.webDist, join("C:/Program Files/Fathom/resources", "web"));
  assert.ok(packaged.dataDir.endsWith("data"));
  assert.equal(packaged.cacheDir, join("C:/Users/me/AppData/Fathom", "cache"));

  const dev = resolveDesktopPaths({
    isPackaged: false,
    repoRoot: "D:/repo",
    resourcesPath: "",
    userData: "C:/Users/me/AppData/Fathom",
  });
  assert.equal(dev.daemonEntry, join("D:/repo", "apps", "desktop", "resources", "daemon.mjs"));
});

test("findFreePort 返回可绑定端口，waitForHealth 能等待服务", async () => {
  const port = await findFreePort();
  assert.ok(port > 0);
  const server = createServer((request, response) => {
    if (request.url === "/api/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    await waitForHealth(`http://127.0.0.1:${port}`, {
      intervalMs: 20,
      timeoutMs: 2_000,
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
});

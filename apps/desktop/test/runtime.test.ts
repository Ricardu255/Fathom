import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildDaemonEnv,
  createDesktopToken,
  decideLink,
  findFreePort,
  parseExternalUrl,
  resolveDesktopPaths,
  waitForHealth,
} from "../src/runtime";

test("桌面环境变量固定为回环地址并指向客户端资源", () => {
  const env = buildDaemonEnv({
    dataDir: "/tmp/data",
    desktopToken: "token-123",
    port: 4321,
    webDist: "/tmp/web",
    workspace: "/tmp/workspace",
  });
  assert.equal(env.HARNESS_HOST, "127.0.0.1");
  assert.equal(env.HARNESS_PORT, "4321");
  assert.equal(env.HARNESS_WEB_ORIGIN, "http://127.0.0.1:4321");
  assert.equal(env.HARNESS_WEB_DIST, "/tmp/web");
  assert.equal(env.HARNESS_DESKTOP_TOKEN, "token-123");
});

test("没有传入桌面令牌时环境变量为空字符串，而不是 undefined", () => {
  const env = buildDaemonEnv({
    dataDir: "/tmp/data",
    port: 4321,
    webDist: "/tmp/web",
    workspace: "/tmp/workspace",
  });
  assert.equal(env.HARNESS_DESKTOP_TOKEN, "");
});

test("应用内窗口只认 daemon 自己的 origin", () => {
  const origin = "http://127.0.0.1:4321";
  assert.deepEqual(decideLink(`${origin}/chat/1`, origin), { action: "allow" });
  // 同协议同端口但不同连接方向（localhost）算跨 origin：daemon 只监听 127.0.0.1。
  assert.deepEqual(decideLink("http://127.0.0.1:9999/", origin), {
    action: "external",
    url: "http://127.0.0.1:9999/",
  });
  assert.deepEqual(decideLink("http://localhost:4321/", origin), {
    action: "external",
    url: "http://localhost:4321/",
  });
});

test("外部链接只放行 http/https", () => {
  const origin = "http://127.0.0.1:4321";
  assert.equal(parseExternalUrl("https://example.com/a"), "https://example.com/a");
  assert.deepEqual(decideLink("https://example.com/a", origin), {
    action: "external",
    url: "https://example.com/a",
  });
  for (const blocked of [
    "file:///C:/Windows/System32/calc.exe",
    "smb://server/share",
    "javascript:alert(1)",
    "ms-msdt:/id",
    "not a url",
  ]) {
    assert.equal(parseExternalUrl(blocked), null, `${blocked} 不应被当成外链`);
    assert.deepEqual(decideLink(blocked, origin), { action: "deny" });
  }
});

test("每次启动生成不同的高熵桌面令牌", () => {
  const first = createDesktopToken();
  const second = createDesktopToken();
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.notEqual(first, second);
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

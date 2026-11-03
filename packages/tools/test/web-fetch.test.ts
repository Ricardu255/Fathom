import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, test } from "node:test";
import { assertPublicHttpUrl, createWebFetchTool, isPrivateAddress } from "../src/web-fetch";

const servers: Server[] = [];

after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("无法获取测试端口");
  return `http://127.0.0.1:${address.port}`;
}

test("SSRF 校验拒绝非 HTTP、本机、私网和元数据地址", async () => {
  await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd"), /http/u);
  await assert.rejects(() => assertPublicHttpUrl("http://127.0.0.1"), /私网|本机/u);
  await assert.rejects(() => assertPublicHttpUrl("http://localhost"), /本机/u);
  await assert.rejects(() => assertPublicHttpUrl("http://169.254.169.254"), /私网/u);
  await assert.rejects(() => assertPublicHttpUrl("http://10.0.0.1"), /私网/u);
  await assert.rejects(() => assertPublicHttpUrl("http://[::1]"), /私网/u);
  await assert.rejects(() => assertPublicHttpUrl("http://[fc00::1]"), /私网/u);
  await assert.rejects(
    () => assertPublicHttpUrl("http://example.com", { resolver: async () => ["192.168.1.1"] }),
    /私网/u,
  );
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("172.16.0.1"), true);
  assert.equal(isPrivateAddress("fe80::1"), true);
});

test("web_fetch 返回文本，并拒绝二进制响应", async () => {
  const base = await listen((request, response) => {
    if (request.url === "/binary") {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from([0, 1, 2]));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("hello web");
  });
  const tool = createWebFetchTool({ allowPrivateNetwork: true });
  const context = { signal: new AbortController().signal, workspaceRoot: process.cwd() };
  const result = await tool.execute({ url: `${base}/` }, context);
  assert.match(result.content, /hello web/u);
  assert.match(result.content, /Content-Type: text\/plain/u);

  await assert.rejects(() => tool.execute({ url: `${base}/binary` }, context), /不支持的内容类型/u);
});

test("web_fetch 跟随重定向并限制循环", async () => {
  const base = await listen((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "/final" });
      response.end();
    } else if (request.url === "/loop") {
      response.writeHead(302, { location: "/loop" });
      response.end();
    } else {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("final page");
    }
  });
  const tool = createWebFetchTool({ allowPrivateNetwork: true });
  const context = { signal: new AbortController().signal, workspaceRoot: process.cwd() };
  const result = await tool.execute({ url: `${base}/redirect` }, context);
  assert.match(result.content, /final page/u);
  assert.match(result.content, /URL: .*\/final/u);
  await assert.rejects(() => tool.execute({ url: `${base}/loop` }, context), /重定向次数/u);
});

test("web_fetch 超时会中止请求", async () => {
  const base = await listen(() => {
    // 故意不结束响应，等待客户端超时。
  });
  const tool = createWebFetchTool({ allowPrivateNetwork: true });
  await assert.rejects(
    () =>
      tool.execute(
        { timeoutMs: 1_000, url: `${base}/slow` },
        { signal: new AbortController().signal, workspaceRoot: process.cwd() },
      ),
    /abort|超时|timed/iu,
  );
});

test("web_fetch 对响应大小与返回字符数有上限", async () => {
  const base = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("x".repeat(100_000));
  });
  const tool = createWebFetchTool({ allowPrivateNetwork: true });
  const result = await tool.execute(
    { maxChars: 500, url: `${base}/` },
    { signal: new AbortController().signal, workspaceRoot: process.cwd() },
  );
  assert.match(result.content, /响应已截断/u);
  assert.ok(result.content.length < 1_000);
});

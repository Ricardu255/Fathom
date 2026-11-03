import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, test } from "node:test";
import { createWebSearchTool } from "../src/web-search";

const servers: Server[] = [];

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
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

test("web_search 调用 SearXNG JSON 并格式化结果", async () => {
  let received: URL | null = null;
  const base = await listen((request, response) => {
    received = new URL(request.url ?? "/", "http://127.0.0.1");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        results: [
          { content: "第一条摘要", title: "结果一", url: "https://example.com/a" },
          { abstract: "第二条摘要", title: "结果二", url: "https://example.com/b" },
        ],
      }),
    );
  });
  const tool = createWebSearchTool({ searxngUrl: base });
  const result = await tool.execute(
    { language: "zh-CN", limit: 2, query: "测试查询" },
    { signal: new AbortController().signal, workspaceRoot: process.cwd() },
  );
  assert.match(result.content, /结果一/u);
  assert.match(result.content, /https:\/\/example.com\/b/u);
  assert.ok(received !== null);
  assert.equal((received as URL).searchParams.get("q"), "测试查询");
  assert.equal((received as URL).searchParams.get("format"), "json");
  assert.equal((received as URL).searchParams.get("language"), "zh-CN");
});

test("未配置搜索服务时返回可操作错误", async () => {
  const tool = createWebSearchTool({});
  const result = await tool.execute(
    { query: "test" },
    { signal: new AbortController().signal, workspaceRoot: process.cwd() },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /HARNESS_SEARXNG_URL/u);
});

test("SearXNG 返回非 JSON 时给出明确错误", async () => {
  const base = await listen((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>not json</html>");
  });
  const tool = createWebSearchTool({ searxngUrl: base });
  await assert.rejects(
    () =>
      tool.execute(
        { query: "test" },
        { signal: new AbortController().signal, workspaceRoot: process.cwd() },
      ),
    /不是有效 JSON/u,
  );
});

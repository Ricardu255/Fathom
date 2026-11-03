import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { HttpEmbedder } from "../src/memory/embedder";

let close: (() => void) | null = null;

after(() => close?.());

test("HTTP Embedder 请求 OpenAI-compatible 端点并归一化向量", async () => {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { input?: string; model?: string };
      assert.equal(parsed.input, "查询");
      assert.equal(parsed.model, "embed-model");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ embedding: [3, 4] }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  close = () => server.close();
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("无法获取测试端口");
  const embedder = new HttpEmbedder({
    dimensions: 2,
    model: "embed-model",
    url: `http://127.0.0.1:${address.port}`,
  });
  const vector = await embedder.embed("查询");
  assert.equal(vector.length, 2);
  assert.ok(Math.abs((vector[0] ?? 0) - 0.6) < 1e-6);
  assert.ok(Math.abs((vector[1] ?? 0) - 0.8) < 1e-6);
  assert.equal(embedder.id, "http:embed-model:2");
});

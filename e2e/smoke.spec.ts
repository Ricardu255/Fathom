import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const run = promisify(execFile);

test("首页可以直接输入并发送第一条消息", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "我们从哪里开始？" })).toBeVisible();
  await expect(page.getByText("新对话", { exact: true }).first()).toBeVisible();
  await page.getByLabel("消息输入").fill("你好，介绍一下你自己");
  await page.getByLabel("发送消息").click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/u);
  await expect(page.getByPlaceholder(/给 Agent 发消息/u)).toBeVisible();
  await expect(page.getByText("你好，介绍一下你自己").first()).toBeVisible();
});

test("快捷提示会填入首页输入框", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "编程" }).click();
  await expect(page.getByLabel("消息输入")).toHaveValue("帮我解决这个编程问题：");
});

test("首页文档附件会在创建会话后上传", async ({ page }) => {
  await page.goto("/");
  await page.locator('.composer input[accept*=".pdf"]').setInputFiles({
    buffer: Buffer.from("hello attachment"),
    name: "note.txt",
    type: "text/plain",
  });
  await expect(page.locator(".composer-doc")).toContainText("note.txt");
  await page.getByLabel("消息输入").fill("总结这个附件");
  await page.getByLabel("发送消息").click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/u);
  await expect(page.locator(".chat-attachment-bar")).toContainText("note.txt");
});

test("刷新首页不会创建空会话", async ({ page, request }) => {
  const before = (await (await request.get("/api/sessions")).json()) as unknown[];
  await page.goto("/");
  await page.reload();
  await expect(page.getByRole("heading", { name: "我们从哪里开始？" })).toBeVisible();
  const after = (await (await request.get("/api/sessions")).json()) as unknown[];
  expect(after.length).toBe(before.length);
});

test("窄屏首页仍可输入", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 820 });
  await page.goto("/");
  await expect(page.getByLabel("消息输入")).toBeVisible();
  await expect(page.getByRole("button", { name: "写作" })).toBeVisible();
});

test("工作区可以添加、重命名并绑定新会话", async ({ page, request }) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "fathom-e2e-workspace-"));
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  try {
    const created = await request.post("/api/workspaces", {
      data: { displayName: "E2E 工作区", path: workspaceRoot },
      headers,
    });
    expect(created.status()).toBe(201);
    const workspace = (await created.json()) as { id: string; rootPath: string };
    expect(workspace.rootPath).toBeTruthy();

    const renamed = await request.patch(`/api/workspaces/${workspace.id}`, {
      data: { displayName: "E2E 工作区改名" },
      headers,
    });
    expect(renamed.ok()).toBeTruthy();

    const sessionResponse = await request.post("/api/sessions", {
      data: { title: "E2E 工作区会话", workspaceId: workspace.id },
      headers,
    });
    expect(sessionResponse.status()).toBe(201);
    const session = (await sessionResponse.json()) as {
      workspaceId: string | null;
      workspaceRoot: string;
    };
    expect(session.workspaceId).toBe(workspace.id);
    expect(session.workspaceRoot).toBe(workspace.rootPath);

    await page.goto("/");
    await expect(page.getByText("E2E 工作区改名").first()).toBeVisible();
    await page.goto(`/?workspace=${encodeURIComponent(workspace.id)}`);
    await expect(page.getByLabel("选择工作区")).toHaveValue(workspace.id);
  } finally {
    const workspaces = (await (await request.get("/api/workspaces?includeRemoved=1")).json()) as {
      id: string;
      rootPath: string;
    }[];
    const created = workspaces.find((item) => item.rootPath === workspaceRoot);
    if (created !== undefined) {
      await request.delete(`/api/workspaces/${created.id}`, { headers });
    }
    await rm(workspaceRoot, { force: true, recursive: true });
  }
});

test("模型目录可以读取并切换会话模型", async ({ request }) => {
  const catalogResponse = await request.get("/api/models");
  expect(catalogResponse.ok()).toBeTruthy();
  const catalog = (await catalogResponse.json()) as {
    default: { modelId: string; providerId: string };
    providers: {
      configured: boolean;
      id: string;
      models: { id: string; thinkingLevels: string[] }[];
    }[];
  };
  const provider = catalog.providers.find((item) => item.configured) ?? catalog.providers[0];
  expect(provider).toBeDefined();
  const model = provider?.models[0];
  expect(model).toBeDefined();

  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const created = await request.post("/api/sessions", {
    data: { title: "E2E 模型切换会话" },
    headers,
  });
  expect(created.status()).toBe(201);
  const session = (await created.json()) as { id: string };
  try {
    const updated = await request.patch(`/api/sessions/${session.id}/model`, {
      data: {
        modelId: model?.id,
        providerId: provider?.id,
        thinkingLevel: model?.thinkingLevels.includes("medium") === true ? "medium" : "off",
      },
      headers,
    });
    expect(updated.ok()).toBeTruthy();
    const body = (await updated.json()) as {
      modelId: string | null;
      providerId: string | null;
    };
    expect(body.providerId).toBe(provider?.id);
    expect(body.modelId).toBe(model?.id);
  } finally {
    await request.delete(`/api/sessions/${session.id}`, { headers });
  }
});

test("首页模型选择器可以切换推理强度", async ({ page }) => {
  await page.goto("/");
  await page.locator(".model-picker-trigger").first().click();
  await expect(page.getByRole("dialog", { name: "选择模型" })).toBeVisible();
  await page.getByLabel("搜索模型").fill("sonnet");
  await expect(page.locator(".model-picker-results button").first()).toBeVisible();
  await page.getByLabel("推理强度").selectOption("high");
  await expect(page.locator(".model-picker-thinking")).toHaveText("高");
});

test("会话页可以查看上下文用量", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("消息输入").fill("你好，介绍一下上下文");
  await page.getByLabel("发送消息").click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/u);
  await page.locator(".context-usage-trigger").click();
  await expect(page.getByRole("dialog", { name: "上下文用量" })).toBeVisible();
  await expect(page.getByText("上下文压缩").first()).toBeVisible();
});

test("OAuth Provider 列表 API 可用", async ({ request }) => {
  const response = await request.get("/api/providers/oauth");
  expect(response.ok()).toBeTruthy();
  const providers = (await response.json()) as {
    configured: boolean;
    id: string;
    loginLabel: string;
    name: string;
  }[];
  expect(Array.isArray(providers)).toBeTruthy();
  for (const provider of providers) {
    expect(provider.id.length).toBeGreaterThan(0);
    expect(provider.loginLabel.length).toBeGreaterThan(0);
    expect(typeof provider.configured).toBe("boolean");
  }
});

test("自定义 Provider 可创建并出现在模型目录", async ({ request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const created = await request.post("/api/providers/custom", {
    data: {
      apiKey: "sk-custom-e2e",
      baseUrl: "https://api.example.com/v1",
      models: [
        {
          contextWindow: 64_000,
          id: "custom-test-model",
          maxTokens: 8_000,
          name: "Custom Test Model",
          reasoning: true,
        },
      ],
      name: "E2E 自定义 Provider",
      protocol: "openai-completions",
      requiresApiKey: true,
    },
    headers,
  });
  expect(created.status()).toBe(201);
  const provider = (await created.json()) as { id: string };
  try {
    const catalog = (await (await request.get("/api/models")).json()) as {
      providers: { id: string; models: { id: string }[] }[];
    };
    expect(
      catalog.providers.some(
        (item) =>
          item.id === provider.id && item.models.some((model) => model.id === "custom-test-model"),
      ),
    ).toBeTruthy();
  } finally {
    await request.delete(`/api/providers/custom/${provider.id}`, { headers });
  }
});

test("命令面板可以搜索并跳转到任务看板", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "命令面板" })).toBeVisible();
  await page.getByLabel("搜索会话或命令").fill("任务");
  await page.getByRole("button", { name: /任务看板/u }).click();
  await expect(page).toHaveURL(/\/board$/u);
  await expect(page.getByRole("heading", { name: "任务看板" })).toBeVisible();
});

test("设置页可以切换主题、审批模式并配置模型接入", async ({ page, request }) => {
  const response = await request.get("/api/settings");
  expect(response.ok()).toBeTruthy();
  const settings = (await response.json()) as {
    apiKeyConfigured: boolean;
    model: string;
    providerId: string;
  };
  expect("apiKey" in settings).toBe(false);
  expect("mockModel" in settings).toBe(false);
  expect(settings.model.length).toBeGreaterThan(0);
  const invalidModel = await request.put("/api/settings/model", {
    data: {
      apiKey: "sk-invalid-e2e",
      modelId: "definitely-not-a-model",
      providerId: "anthropic",
    },
    headers: { origin: "http://127.0.0.1:4399", "x-harness-request": "1" },
  });
  expect(invalidModel.status()).toBe(400);

  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "模型与 API" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "存储位置" })).toBeVisible();
  await expect(page.getByText(/数据和缓存目录只能在 Fathom 桌面客户端中修改/u)).toBeVisible();
  await expect(page.locator(".sidebar-footer select")).toHaveCount(0);
  await expect(page.locator(".sidebar-settings-link")).toBeVisible();
  await expect(page.getByText(/Mock/u)).toHaveCount(0);
  await expect(page.locator(".settings-switch-row")).toHaveCount(0);

  await page.getByRole("button", { name: "墨夜深色", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "奶白纸面", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  const approvalSection = page.locator("#approval");
  const radios = approvalSection.getByRole("radio");
  await expect(radios).toHaveCount(3);
  await page.locator(".approval-option").nth(1).click();
  await expect(radios.nth(1)).toBeChecked();
  await expect
    .poll(async () => {
      const current = (await (await request.get("/api/settings")).json()) as {
        approvalMode: string;
      };
      return current.approvalMode;
    })
    .toBe("auto_approve");
  await page.locator(".approval-option").nth(2).click();
  await expect(radios.nth(2)).toBeChecked();
  await expect
    .poll(async () => {
      const current = (await (await request.get("/api/settings")).json()) as {
        approvalMode: string;
      };
      return current.approvalMode;
    })
    .toBe("full_access");
  await page.locator(".approval-option").nth(0).click();
  await expect(radios.nth(0)).toBeChecked();

  const provider = page.locator(".model-settings select").first();
  const apiKey = page.locator(".model-settings input[type=password]");
  const save = page.getByRole("button", { name: "保存并应用" });
  await expect(provider).toHaveValue(settings.providerId);
  await expect(apiKey).toHaveValue("");
  if (settings.apiKeyConfigured) {
    await expect(save).toBeEnabled();
  } else {
    await expect(save).toBeDisabled();
    await expect(page.getByText("填写 Provider 的 API Key 后才能保存并接入模型。")).toBeVisible();
    await page.getByRole("button", { name: "测试连接" }).click();
    await expect(page.getByText("尚未接入真实模型，无法执行连接测试")).toBeVisible();
    await apiKey.fill("sk-ui-only-not-saved");
    await expect(save).toBeEnabled();
    await apiKey.fill("");
    await expect(save).toBeDisabled();
  }
});

test("任务看板可以创建任务并显示在待开始列", async ({ page }) => {
  await page.goto("/board");
  const title = `E2E 看板任务 ${Date.now()}`;
  await page.getByRole("button", { name: "新建任务" }).first().click();
  await page.getByLabel("标题").fill(title);
  await page.getByLabel("任务目标与验收要求").fill("验证任务创建链路");
  await page.getByRole("button", { name: "创建任务" }).click();
  await expect(page.getByText(title).first()).toBeVisible();
  await expect(page.getByRole("dialog").getByText("待开始")).toBeVisible();
});

test("会话搜索、归档与恢复 API 可用", async ({ request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const created = await request.post("/api/sessions", {
    data: { title: "E2E 搜索会话" },
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string; title: string };

  const search = await request.get("/api/sessions/search", {
    params: { q: "E2E 搜索会话" },
  });
  expect(search.ok()).toBeTruthy();
  const hits = (await search.json()) as { sessionId: string }[];
  expect(hits.some((hit) => hit.sessionId === session.id)).toBeTruthy();

  const archived = await request.delete(`/api/sessions/${session.id}`, { headers });
  expect(archived.status()).toBe(204);
  const archivedList = await request.get("/api/sessions", {
    params: { includeArchived: "1" },
  });
  const archivedSessions = (await archivedList.json()) as {
    archivedAt: number | null;
    id: string;
  }[];
  expect(
    archivedSessions.some((item) => item.id === session.id && item.archivedAt !== null),
  ).toBeTruthy();

  const restored = await request.post(`/api/sessions/${session.id}/restore`, { headers });
  expect(restored.ok()).toBeTruthy();
  const activeList = await request.get("/api/sessions");
  const activeSessions = (await activeList.json()) as { id: string }[];
  expect(activeSessions.some((item) => item.id === session.id)).toBeTruthy();
});

test("命令面板可以按标题搜索会话", async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const title = `E2E 会话 ${Date.now()}`;
  const created = await request.post("/api/sessions", { data: { title }, headers });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };

  await page.goto("/");
  await page.keyboard.press("Control+k");
  await page.getByLabel("搜索会话或命令").fill(title);
  const result = page.getByRole("button", { name: new RegExp(title) });
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(new RegExp(`/s/${session.id}$`));
});

test("长期记忆 API 与页面可用", async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const title = `E2E 记忆 ${Date.now()}`;
  const created = await request.post("/api/memories", {
    data: { content: `${title}：偏好使用 pnpm。`, title },
    headers,
  });
  expect(created.status()).toBe(201);
  const memory = (await created.json()) as { id: string; title: string };

  const search = await request.get("/api/memories/search", { params: { q: "pnpm" } });
  expect(search.ok()).toBeTruthy();
  const hits = (await search.json()) as { documentTitle: string }[];
  expect(hits.some((hit) => hit.documentTitle === title)).toBeTruthy();

  await page.goto("/memory");
  await expect(page.getByText(title).first()).toBeVisible();

  const deleted = await request.delete(`/api/memories/${memory.id}`, { headers });
  expect(deleted.status()).toBe(204);
});

test("消息可以携带图片并写入事件历史", async ({ request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const created = await request.post("/api/sessions", {
    data: { title: `E2E 图片 ${Date.now()}` },
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };

  const sent = await request.post(`/api/sessions/${session.id}/messages`, {
    data: {
      images: [
        {
          data: "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",
          mimeType: "image/png",
        },
      ],
      text: "看一下这张图",
    },
    headers,
  });
  expect(sent.status()).toBe(202);

  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${session.id}`);
        const body = (await snapshot.json()) as {
          messages: { content: { type: string }[] }[];
        };
        return body.messages.some((message) =>
          message.content.some((block) => block.type === "image"),
        );
      },
      { timeout: 15_000 },
    )
    .toBe(true);
});

test("@ 引用会列出工作区文件并插入路径", async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  await writeFile(join(process.cwd(), ".e2e-workspace", "mention-test.md"), "# mention test\n");
  const created = await request.post("/api/sessions", {
    data: { title: `E2E @ 引用 ${Date.now()}` },
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };

  await page.goto(`/s/${session.id}`);
  const composer = page.getByLabel("消息输入");
  await composer.fill("@mention");
  const item = page.getByRole("button", { name: /mention-test\.md/u });
  await expect(item).toBeVisible();
  await item.click();
  await expect(composer).toHaveValue(/@mention-test\.md/u);
});

test("会话 fork API 返回新会话并继承标题", async ({ request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const title = `E2E Fork ${Date.now()}`;
  const created = await request.post("/api/sessions", { data: { title }, headers });
  expect(created.ok()).toBeTruthy();
  const source = (await created.json()) as { id: string };
  const sent = await request.post(`/api/sessions/${source.id}/messages`, {
    data: { text: "用于 fork 的历史消息" },
    headers,
  });
  expect(sent.status()).toBe(202);
  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${source.id}`);
        const body = (await snapshot.json()) as {
          isRunning: boolean;
          messages: unknown[];
        };
        return !body.isRunning && body.messages.length > 0;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  const forked = await request.post(`/api/sessions/${source.id}/fork`, { headers });
  expect(forked.status()).toBe(201);
  const target = (await forked.json()) as { id: string; title: string };
  expect(target.id).not.toBe(source.id);
  expect(target.title).toContain(title);
  expect(target.title).toContain("分支");
  const copied = await request.get(`/api/sessions/${target.id}`);
  const copiedBody = (await copied.json()) as { messages: unknown[] };
  expect(copiedBody.messages.length).toBeGreaterThan(0);
});

test("运行中的 Run 可以接收 steering", async ({ request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const created = await request.post("/api/sessions", {
    data: { title: `E2E Steering ${Date.now()}` },
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };

  const started = await request.post(`/api/sessions/${session.id}/messages`, {
    data: { text: "运行一个工作流" },
    headers,
  });
  expect(started.status()).toBe(202);

  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${session.id}`);
        return ((await snapshot.json()) as { isRunning: boolean }).isRunning;
      },
      { timeout: 5_000 },
    )
    .toBe(true);

  const steered = await request.post(`/api/sessions/${session.id}/steer`, {
    data: { text: "补充：优先保证引用准确" },
    headers,
  });
  expect(steered.status()).toBe(202);
  const body = (await steered.json()) as { disposition: string };
  expect(["handled", "queued"]).toContain(body.disposition);

  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${session.id}`);
        return ((await snapshot.json()) as { isRunning: boolean }).isRunning;
      },
      { timeout: 20_000 },
    )
    .toBe(false);
});

test("新建 Run 会自动召回长期记忆并显示注入标记", async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const keyword = `memoryinject${Date.now()}`;
  const memoryTitle = `E2E 自动召回 ${Date.now()}`;
  const memoryResponse = await request.post("/api/memories", {
    data: { content: `${keyword} 表示用户偏好 TypeScript strict。`, title: memoryTitle },
    headers,
  });
  expect(memoryResponse.status()).toBe(201);
  const memory = (await memoryResponse.json()) as { id: string };

  const created = await request.post("/api/sessions", {
    data: { title: `E2E 召回 ${Date.now()}` },
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };
  const sent = await request.post(`/api/sessions/${session.id}/messages`, {
    data: { text: `${keyword} 请按偏好实现一个函数` },
    headers,
  });
  expect(sent.status()).toBe(202);

  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${session.id}`);
        const body = (await snapshot.json()) as {
          memoryRecall: { titles: string[] } | null;
        };
        return body.memoryRecall?.titles.includes(memoryTitle) === true;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.goto(`/s/${session.id}`);
  await expect(page.locator(".app-statusbar").getByText(/\d+ 条记忆/u)).toBeVisible();
  await request.delete(`/api/memories/${memory.id}`, { headers });
});

test("可以从历史用户消息创建 fork 并显示父会话", async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const title = `E2E 历史 Fork ${Date.now()}`;
  const created = await request.post("/api/sessions", { data: { title }, headers });
  expect(created.ok()).toBeTruthy();
  const source = (await created.json()) as { id: string };

  await request.post(`/api/sessions/${source.id}/messages`, {
    data: { text: "第一条历史消息" },
    headers,
  });
  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${source.id}`);
        const body = (await snapshot.json()) as {
          isRunning: boolean;
          messages: { role: string }[];
        };
        return !body.isRunning && body.messages.length >= 2;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  const firstSnapshot = await request.get(`/api/sessions/${source.id}`);
  const firstBody = (await firstSnapshot.json()) as {
    messages: { content: { text?: string }[]; role: string; timestamp: number }[];
  };
  const firstUser = firstBody.messages.find((message) => message.role === "user");
  expect(firstUser).toBeDefined();
  const firstTimestamp = firstUser?.timestamp;
  expect(firstTimestamp).toBeGreaterThan(0);

  await request.post(`/api/sessions/${source.id}/messages`, {
    data: { text: "第二条不应进入分支" },
    headers,
  });
  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${source.id}`);
        const body = (await snapshot.json()) as {
          isRunning: boolean;
          messages: { role: string }[];
        };
        return !body.isRunning && body.messages.length >= 4;
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  const forked = await request.post(
    `/api/sessions/${source.id}/fork?fromTimestamp=${firstTimestamp}`,
    { headers },
  );
  expect(forked.status()).toBe(201);
  const target = (await forked.json()) as {
    id: string;
    parentSessionId: string | null;
    title: string;
  };
  expect(target.parentSessionId).toBe(source.id);

  const copied = await request.get(`/api/sessions/${target.id}`);
  const copiedBody = (await copied.json()) as {
    messages: { content: { text?: string }[] }[];
  };
  const copiedText = copiedBody.messages
    .flatMap((message) => message.content)
    .flatMap((block) => (block.text === undefined ? [] : [block.text]))
    .join("\n");
  expect(copiedText).toContain("第一条历史消息");
  expect(copiedText).not.toContain("第二条不应进入分支");

  await page.goto(`/s/${target.id}`);
  await expect(page.getByText(new RegExp(`分支自 ${title}`, "u"))).toBeVisible();
});

test("分支树展示父子会话并可以跳转", async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const title = `E2E 分支树 ${Date.now()}`;
  const created = await request.post("/api/sessions", { data: { title }, headers });
  expect(created.ok()).toBeTruthy();
  const parent = (await created.json()) as { id: string };
  const forked = await request.post(`/api/sessions/${parent.id}/fork`, { headers });
  expect(forked.status()).toBe(201);
  const child = (await forked.json()) as { id: string; title: string };

  await page.goto(`/s/${parent.id}`);
  await page.getByRole("button", { name: "分支树" }).click();
  const dialog = page.getByRole("dialog", { name: "分支树" });
  await expect(dialog.getByText(title).first()).toBeVisible();
  await expect(dialog.getByText(child.title).first()).toBeVisible();
  await dialog.getByRole("button", { name: new RegExp(child.title) }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${child.id}$`));
});

test("工作流编辑器可以应用模板并直接运行 DAG", { timeout: 60_000 }, async ({ page }) => {
  await page.goto("/workflows");
  await page.getByRole("button", { name: "示例模板" }).click();
  await expect(page.getByLabel("节点 1 标题")).toHaveValue("调研工作区");
  await page.getByRole("button", { name: "保存并运行" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/u, { timeout: 15_000 });
  await expect(page.getByText(/工作流结果（/u)).toBeVisible({ timeout: 40_000 });
  await expect(page.getByText(/调研工作区/u).first()).toBeVisible();
});

test("工作流可以保存、重新载入并从已保存版本运行", { timeout: 60_000 }, async ({ page }) => {
  const title = `E2E 保存流程 ${Date.now()}`;
  await page.goto("/workflows");
  await page.getByLabel("工作流标题").fill(title);
  await page.getByLabel("节点 1 标题").fill("单节点调研");
  await page.getByLabel("节点 1 任务").fill("调研工作区并总结");
  await page.getByLabel("cron 表达式").fill("*/15 * * * *");
  await page.getByLabel("调度时区").fill("Asia/Shanghai");
  await page.getByLabel("Webhook 触发").check();
  await page.getByLabel("文件变更触发").check();
  await page.getByLabel("文件监听路径").fill("mention-test.md");
  await page.getByLabel("触发条件类型").selectOption("fileMatches");
  await page.getByLabel("触发条件值").fill("**/*.md");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.getByText(new RegExp(`已保存「${title}」`, "u"))).toBeVisible();

  await page.reload();
  const savedItem = page.locator(".workflow-saved-load").filter({ hasText: title });
  await expect(savedItem).toBeVisible();
  await savedItem.click();
  await expect(page.getByLabel("工作流标题")).toHaveValue(title);
  await expect(page.getByLabel("cron 表达式")).toHaveValue("*/15 * * * *");
  await expect(page.getByLabel("调度时区")).toHaveValue("Asia/Shanghai");
  await expect(page.getByLabel("Webhook 触发")).toBeChecked();
  await expect(page.getByLabel("文件变更触发")).toBeChecked();
  await expect(page.getByLabel("文件监听路径")).toHaveValue("mention-test.md");
  await expect(page.getByLabel("触发条件类型")).toHaveValue("fileMatches");
  await expect(page.getByLabel("触发条件值")).toHaveValue("**/*.md");
  await expect(page.locator(".workflow-webhook code")).toContainText("/webhook?token=");

  await page.getByRole("button", { name: "保存并运行" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/u, { timeout: 15_000 });
  await expect(page.getByText(/工作流结果（/u)).toBeVisible({ timeout: 40_000 });

  await page.goto("/workflows");
  const savedRow = page.locator(".workflow-saved-item").filter({ hasText: title });
  await savedRow.getByRole("button", { name: /查看运行历史/u }).click();
  const history = page.getByRole("dialog", { name: "运行历史" });
  await expect(history.getByText("已完成")).toBeVisible({ timeout: 15_000 });
});

test("计划模式会阻断副作用工具并支持批准执行", async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const created = await request.post("/api/sessions", {
    data: { title: `E2E 计划模式 ${Date.now()}` },
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };

  const sent = await request.post(`/api/sessions/${session.id}/messages`, {
    data: { planMode: true, text: "创建一个文件来验证计划模式" },
    headers,
  });
  expect(sent.status()).toBe(202);

  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${session.id}`);
        return ((await snapshot.json()) as { isRunning: boolean }).isRunning;
      },
      { timeout: 15_000 },
    )
    .toBe(false);

  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${session.id}`);
        const body = (await snapshot.json()) as { plan: { text: string } | null };
        return body.plan?.text ?? "";
      },
      { timeout: 10_000 },
    )
    .not.toBe("");

  const snapshot = await request.get(`/api/sessions/${session.id}`);
  const body = (await snapshot.json()) as {
    approvals: unknown[];
    fileChanges: unknown[];
    messages: unknown[];
    plan: { text: string } | null;
  };
  expect(body.fileChanges.length).toBe(0);
  expect(body.approvals.length).toBe(0);
  expect(body.messages.length).toBeGreaterThan(0);
  expect(body.plan?.text.length).toBeGreaterThan(0);

  await page.goto(`/s/${session.id}`);
  const addMenu = page.getByRole("button", { name: "添加文件等内容" });
  await addMenu.click();
  const toggle = page.getByRole("menuitemcheckbox", { name: "计划模式" });
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await toggle.click();
  await expect(addMenu).toHaveClass(/active/u);
  const planCard = page.locator(".plan-card");
  await expect(planCard).toBeVisible();
  await page.getByRole("button", { name: "批准并执行" }).click();
  await expect(planCard).toBeHidden();
  await expect(addMenu).not.toHaveClass(/active/u);
});

test("文档附件上传后注入上下文并显示在会话中", async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const created = await request.post("/api/sessions", {
    data: { title: `E2E 文档附件 ${Date.now()}` },
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };

  const uploaded = await request.post(`/api/sessions/${session.id}/attachments`, {
    headers,
    multipart: {
      file: {
        buffer: Buffer.from("# 附件说明\n\n项目使用 pnpm，测试命令是 pnpm test。\n"),
        mimeType: "text/markdown",
        name: "notes.md",
      },
    },
  });
  expect(uploaded.status()).toBe(201);
  const attachment = (await uploaded.json()) as { fileName: string; id: string };
  expect(attachment.fileName).toBe("notes.md");

  const sent = await request.post(`/api/sessions/${session.id}/messages`, {
    data: { attachments: [attachment.id], text: "请总结附件内容" },
    headers,
  });
  expect(sent.status()).toBe(202);

  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${session.id}`);
        const body = (await snapshot.json()) as {
          attachments: { attachments: { fileName: string }[] } | null;
          isRunning: boolean;
        };
        return !body.isRunning && body.attachments?.attachments[0]?.fileName === "notes.md";
      },
      { timeout: 15_000 },
    )
    .toBe(true);

  await page.goto(`/s/${session.id}`);
  await expect(page.locator(".chat-attachment-bar").getByText(/notes\.md/u)).toBeVisible();
});

test("Webhook 可以在非同源请求下触发工作流", { timeout: 30_000 }, async ({ request }) => {
  const created = await request.post("/api/workflows", {
    data: {
      nodes: [{ id: "research", task: "调研工作区", title: "Webhook 调研" }],
      title: `E2E Webhook ${Date.now()}`,
      triggerCondition: { type: "webhookContains", value: "deploy" },
      webhookEnabled: true,
    },
    headers: { origin: "http://127.0.0.1:4399", "x-harness-request": "1" },
  });
  expect(created.status()).toBe(201);
  const workflow = (await created.json()) as { id: string; webhookToken: string };

  const skipped = await request.post(
    `/api/workflows/${workflow.id}/webhook?token=${workflow.webhookToken}`,
    { data: { event: "other" } },
  );
  expect(skipped.status()).toBe(202);
  expect(((await skipped.json()) as { skipped?: boolean }).skipped).toBe(true);

  const triggered = await request.post(
    `/api/workflows/${workflow.id}/webhook?token=${workflow.webhookToken}`,
    { data: { event: "deploy" } },
  );
  expect(triggered.status()).toBe(202);

  await expect
    .poll(
      async () => {
        const runs = await request.get(`/api/workflows/${workflow.id}/runs`);
        const body = (await runs.json()) as { status: string }[];
        return body.some((run) => run.status === "completed");
      },
      { timeout: 20_000 },
    )
    .toBe(true);

  const denied = await request.post(`/api/workflows/${workflow.id}/webhook?token=wrong`);
  expect(denied.status()).toBe(404);
});

test("分支可以对比差异并合并为新的摘要分支", { timeout: 60_000 }, async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const parentResponse = await request.post("/api/sessions", {
    data: { title: `E2E 合并父 ${Date.now()}` },
    headers,
  });
  expect(parentResponse.ok()).toBeTruthy();
  const parent = (await parentResponse.json()) as { id: string };

  await request.post(`/api/sessions/${parent.id}/messages`, {
    data: { text: "父分支共同消息" },
    headers,
  });
  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${parent.id}`);
        return ((await snapshot.json()) as { isRunning: boolean }).isRunning;
      },
      { timeout: 15_000 },
    )
    .toBe(false);

  const childResponse = await request.post(`/api/sessions/${parent.id}/fork`, { headers });
  expect(childResponse.status()).toBe(201);
  const child = (await childResponse.json()) as { id: string };

  await request.post(`/api/sessions/${child.id}/messages`, {
    data: { text: "子分支独有内容" },
    headers,
  });
  await expect
    .poll(
      async () => {
        const snapshot = await request.get(`/api/sessions/${child.id}`);
        return ((await snapshot.json()) as { isRunning: boolean }).isRunning;
      },
      { timeout: 15_000 },
    )
    .toBe(false);

  const compareResponse = await request.get("/api/sessions/compare", {
    params: { base: parent.id, target: child.id },
  });
  expect(compareResponse.ok()).toBeTruthy();
  const diff = (await compareResponse.json()) as {
    commonPrefix: number;
    target: { messages: { content: { text?: string }[] }[] };
  };
  expect(diff.commonPrefix).toBeGreaterThan(0);
  expect(
    diff.target.messages.some((message) =>
      message.content.some((block) => block.text === "子分支独有内容"),
    ),
  ).toBeTruthy();

  await page.goto(`/s/${child.id}`);
  await page.getByRole("button", { name: "对比" }).click();
  const dialog = page.getByRole("dialog", { name: "分支对比" });
  await expect(dialog.getByText("子分支独有内容", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "摘要合并新分支" }).click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/u, { timeout: 15_000 });
  await expect(page.getByText(/【分支合并摘要】/u)).toBeVisible();
});

test("工作区抽屉可以预览并保存文本文件", async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const fileName = `workspace-edit-${Date.now()}.md`;
  const relativePath = `.e2e-workspace/${fileName}`;
  await writeFile(join(process.cwd(), relativePath), "# initial\n");
  const created = await request.post("/api/sessions", {
    data: { title: `E2E 工作区 ${Date.now()}` },
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };

  await page.goto(`/s/${session.id}`);
  await page.getByRole("button", { name: "打开工作区" }).click();
  const drawer = page.getByRole("dialog", { name: "工作区文件" });
  await drawer.getByRole("button", { name: new RegExp(fileName, "u") }).click();
  const editor = drawer.getByLabel("文件内容");
  await expect(editor).toHaveValue("# initial\n");
  await editor.fill("# edited from UI\n");
  await drawer.getByRole("button", { name: "保存" }).click();
  await expect(drawer.getByText(/已保存/u)).toBeVisible();
  const content = await readFile(join(process.cwd(), relativePath), "utf8");
  expect(content).toBe("# edited from UI\n");
});

test("后台命令可以启动、查看输出并停止", { timeout: 45_000 }, async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const created = await request.post("/api/sessions", {
    data: { title: `E2E 后台命令 ${Date.now()}` },
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };

  await page.goto(`/s/${session.id}`);
  await page.getByRole("button", { name: "打开后台命令" }).click();
  const drawer = page.getByRole("dialog", { name: "后台命令" });
  await drawer.getByRole("textbox", { name: "后台命令" }).fill("node -e \"console.log('bg-e2e')\"");
  await drawer.getByRole("button", { name: "启动" }).click();
  await expect(drawer.getByText(/bg-e2e/u).first()).toBeVisible({ timeout: 15_000 });
  await expect(drawer.getByText("已退出")).toBeVisible({ timeout: 15_000 });

  await drawer
    .getByRole("textbox", { name: "后台命令" })
    .fill('node -e "setInterval(() => {}, 1000)"');
  await drawer.getByRole("button", { name: "启动" }).click();
  await expect(drawer.getByText("运行中")).toBeVisible({ timeout: 10_000 });
  await drawer.getByRole("button", { name: "停止" }).first().click();
  await expect(drawer.getByText("已停止")).toBeVisible({ timeout: 10_000 });
});

test("Git 抽屉可以查看、暂存并提交文件", { timeout: 45_000 }, async ({ page, request }) => {
  const repo = await mkdtemp(join(tmpdir(), "fathom-git-e2e-"));
  try {
    await run("git", ["init"], { cwd: repo });
    await run("git", ["config", "user.email", "e2e@example.com"], { cwd: repo });
    await run("git", ["config", "user.name", "E2E"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "# git e2e\n");

    const created = await request.post("/api/sessions", {
      data: { title: `E2E Git ${Date.now()}`, workspaceRoot: repo },
      headers: { origin: "http://127.0.0.1:4399", "x-harness-request": "1" },
    });
    expect(created.ok()).toBeTruthy();
    const session = (await created.json()) as { id: string };

    await page.goto(`/s/${session.id}`);
    await page.getByRole("button", { name: "打开 Git" }).click();
    const drawer = page.getByRole("dialog", { name: "Git" });
    await expect(drawer.getByText("README.md")).toBeVisible();
    await drawer.getByRole("button", { name: "暂存 README.md" }).click();
    await drawer.getByLabel("提交信息").fill("initial commit");
    await drawer.getByRole("button", { name: "提交已暂存" }).click();
    await expect(drawer.getByText("工作区干净。")).toBeVisible({ timeout: 15_000 });
  } finally {
    await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("显式要求自主迭代时会自动续轮且不显示内部消息", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("消息输入").fill("请自动续轮完成任务");
  await page.getByLabel("发送消息").click();
  await expect(page.getByText("续轮完成。").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Continue the autonomous task/u)).toHaveCount(0);
});

test("会话页可以打开上下文检查点空态", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("消息输入").fill("你好");
  await page.getByLabel("发送消息").click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/u);
  await page.getByRole("button", { name: "查看上下文检查点" }).click();
  const dialog = page.getByRole("dialog", { name: "上下文检查点" });
  await expect(dialog.getByText("还没有结构化检查点。", { exact: false })).toBeVisible();
});

test("编辑并重跑会创建新分支并运行", async ({ page }) => {
  await page.goto("/");
  const original = `原始问题-${Date.now()}`;
  await page.getByLabel("消息输入").fill(original);
  await page.getByLabel("发送消息").click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/u);
  await expect(page.getByText(original).first()).toBeVisible();
  const originalUrl = page.url();

  await page.getByText(original).first().hover();
  await page.getByRole("button", { name: "编辑并重跑" }).click();
  const dialog = page.getByRole("dialog", { name: "编辑并重跑" });
  await dialog.getByLabel("改写后的消息").fill("改写后的问题");
  await dialog.getByRole("button", { name: "创建分支并运行" }).click();

  await expect(page).not.toHaveURL(originalUrl);
  await expect(page.getByText("改写后的问题").first()).toBeVisible({ timeout: 15_000 });
});

test("文件变更撤销/重放 API 拒绝不存在的记录", async ({ request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const created = await request.post("/api/sessions", {
    data: { title: `E2E FileChanges ${Date.now()}` },
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };

  const response = await request.post(`/api/sessions/${session.id}/file-changes/undo`, {
    data: { paths: ["missing.txt"] },
    headers,
  });
  expect(response.status()).toBe(404);
});

test("上下文检查点 API 可以列出并拒绝无效对比/恢复", async ({ request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const created = await request.post("/api/sessions", {
    data: { title: `E2E Checkpoints ${Date.now()}` },
    headers,
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };

  const listed = await request.get(`/api/sessions/${session.id}/checkpoints`);
  expect(listed.ok()).toBeTruthy();
  expect((await listed.json()) as { checkpoints: unknown[] }).toEqual({ checkpoints: [] });

  const compared = await request.get(
    `/api/sessions/${session.id}/checkpoints/compare?base=missing-a&target=missing-b`,
  );
  expect(compared.status()).toBe(404);

  const restored = await request.post(`/api/sessions/${session.id}/checkpoints/missing/restore`, {
    headers,
  });
  expect(restored.status()).toBe(404);
});

test("Skills 可发现、切换并在 Composer 中通过 $ 引用", async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  const skillDir = join(".e2e-data", "skills", "e2e-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: e2e-skill\ndescription: E2E 测试 Skill\n---\n\n# E2E\n\n执行测试步骤。\n",
    "utf8",
  );
  try {
    const listed = (await (await request.get("/api/skills")).json()) as {
      skills: Array<{ enabled: boolean; id: string; scope: string }>;
    };
    const skill = listed.skills.find((item) => item.id === "e2e-skill" && item.scope === "global");
    expect(skill?.enabled).toBe(true);

    await page.goto("/settings");
    await page.getByRole("link", { name: "Skills" }).click();
    await expect(page.getByText("e2e-skill").first()).toBeVisible();

    await page.goto("/");
    await page.getByLabel("消息输入").fill("你好");
    await page.getByLabel("发送消息").click();
    await expect(page).toHaveURL(/\/s\/[^/]+$/u);
    const input = page.getByLabel("消息输入");
    await input.fill("请用 $e2e");
    await expect(page.locator(".mention-menu").getByText("$e2e-skill")).toBeVisible();

    const toggled = await request.put("/api/settings/skills/global/e2e-skill", {
      data: { enabled: false },
      headers,
    });
    expect(toggled.ok()).toBeTruthy();
    const after = (await (await request.get("/api/skills")).json()) as {
      skills: Array<{ enabled: boolean; id: string; scope: string }>;
    };
    expect(
      after.skills.find((item) => item.id === "e2e-skill" && item.scope === "global")?.enabled,
    ).toBe(false);
  } finally {
    await request.put("/api/settings/skills/global/e2e-skill", {
      data: { enabled: true },
      headers,
    });
    await rm(skillDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

test("会话可以切换对话、轨迹与文件视图", async ({ page, request }) => {
  const created = await request.post("/api/sessions", {
    data: { title: `E2E Views ${Date.now()}` },
    headers: { origin: "http://127.0.0.1:4399", "x-harness-request": "1" },
  });
  expect(created.ok()).toBeTruthy();
  const session = (await created.json()) as { id: string };
  await page.goto(`/s/${session.id}`);
  await page.getByRole("button", { name: "轨迹", exact: true }).click();
  await expect(page.locator(".trace-toolbar")).toBeVisible();
  await page.getByRole("button", { name: "文件", exact: true }).click();
  await expect(page.locator(".workspace-browser")).toBeVisible();
  await page.getByRole("button", { name: "对话", exact: true }).click();
  await expect(page.getByLabel("消息输入")).toBeVisible();
});

test("用量统计与执行轨迹页面可用", async ({ page, request }) => {
  await page.goto("/");
  await page.getByLabel("消息输入").fill("你好，统计一下用量");
  await page.getByLabel("发送消息").click();
  await expect(page).toHaveURL(/\/s\/[^/]+$/u);
  await expect(page.getByText("你好，统计一下用量").first()).toBeVisible();
  const sessionId = page.url().split("/").at(-1) ?? "";

  await page.getByRole("button", { name: "查看执行轨迹" }).click();
  await expect(page).toHaveURL(/\/trace$/u);
  await expect(page.getByRole("heading", { name: "执行轨迹" })).toBeVisible();
  const requestEntry = page.locator(".trace-request").first();
  await expect(requestEntry).toBeVisible();
  await requestEntry.click();
  await expect(page.getByRole("dialog")).toContainText("请求 #1");
  await page.getByRole("button", { name: "System Prompt" }).click();
  await expect(page.locator(".trace-json")).toBeVisible();

  const trace = await request.get(`/api/sessions/${sessionId}/trace`);
  expect(trace.ok()).toBeTruthy();

  await page.goto("/usage");
  await expect(page.getByRole("heading", { name: "用量统计" })).toBeVisible();
  await expect(page.locator(".usage-heatmap")).toBeVisible();
  const usage = (await (await request.get("/api/usage")).json()) as {
    requests: number;
    totalTokens: number;
  };
  expect(usage.requests).toBeGreaterThan(0);
  expect(usage.totalTokens).toBeGreaterThan(0);
});

test("设置页可以保存沙箱 Profile 与域名", async ({ page, request }) => {
  const headers = { origin: "http://127.0.0.1:4399", "x-harness-request": "1" };
  try {
    await page.goto("/settings");
    await page.getByRole("link", { name: "沙箱" }).click();
    await page.locator(".sandbox-profile").filter({ hasText: "只读" }).click();
    await page.getByLabel("域名白名单（每行一个，留空表示不限制）").fill("example.com");
    await page.getByRole("button", { name: "保存沙箱设置" }).click();
    await expect(page.getByText("沙箱设置已保存")).toBeVisible();

    const settings = (await (await request.get("/api/settings")).json()) as {
      sandbox: { allowedDomains: string[]; profile: string };
    };
    expect(settings.sandbox.profile).toBe("read_only");
    expect(settings.sandbox.allowedDomains).toEqual(["example.com"]);
  } finally {
    await request.put("/api/settings/sandbox", {
      data: { allowedDomains: [], deniedDomains: [], profile: "off" },
      headers,
    });
  }
});

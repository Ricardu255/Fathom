import { existsSync } from "node:fs";
import { join } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const executable = join(
  process.cwd(),
  "apps",
  "desktop",
  "node_modules",
  "electron",
  "dist",
  "electron.exe",
);

test.skip(!existsSync(executable), "Electron binary is not installed");

test("Electron 客户端加载 Fathom 工作台并显示集成状态栏", async () => {
  const app = await electron.launch({
    args: ["apps/desktop", "--no-sandbox"],
    env: { ...process.env, HARNESS_MOCK_MODEL: "1" },
    executablePath: executable,
  });
  try {
    const page = await app.firstWindow();
    await page.waitForSelector(".app-statusbar");
    await expect(page).toHaveTitle("Fathom");
    await expect(page.locator(".app-status-brand")).toHaveText("Fathom");
    await expect(page.getByText("任务看板").first()).toBeVisible();
    await expect(page.locator(".app-status-local")).toContainText("本地");
    await expect(page.locator(".workspace-group").first()).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-desktop"))).toBe(
      "true",
    );
    await page.locator(".sidebar-settings-link").click();
    await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "模型与 API" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "存储位置" })).toBeVisible();
    await expect(page.locator(".storage-row")).toHaveCount(2);
    await expect(page.locator(".storage-row code").first()).toContainText("data");
  } finally {
    await app.close();
  }
});

import { defineConfig } from "@playwright/test";

const PORT = 4399;
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  expect: { timeout: 10_000 },
  fullyParallel: false,
  outputDir: "test-results",
  retries: 0,
  testDir: "e2e",
  timeout: 30_000,
  use: {
    baseURL,
    channel: process.env.CI === undefined ? "msedge" : undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node --import tsx apps/daemon/src/bootstrap.ts",
    env: {
      HARNESS_DATA_DIR: ".e2e-data",
      HARNESS_HOST: "127.0.0.1",
      HARNESS_MOCK_MODEL: "1",
      HARNESS_PORT: String(PORT),
      HARNESS_WEB_ORIGIN: baseURL,
      HARNESS_WORKSPACE: ".e2e-workspace",
    },
    reuseExistingServer: false,
    timeout: 60_000,
    url: `${baseURL}/api/health`,
  },
  workers: 1,
});

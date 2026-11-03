import { defineConfig } from "@playwright/test";

export default defineConfig({
  expect: { timeout: 15_000 },
  fullyParallel: false,
  outputDir: "test-results-desktop",
  retries: 0,
  testDir: "e2e-desktop",
  timeout: 60_000,
  workers: 1,
});

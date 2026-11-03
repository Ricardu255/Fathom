import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessDatabase } from "../src/storage/database";

test("沙箱设置默认关闭，并持久化规范化后的 Profile 与域名", async () => {
  const root = await mkdtemp(join(tmpdir(), "fathom-settings-"));
  const database = new HarnessDatabase(join(root, "harness.sqlite"));
  try {
    assert.equal(database.getSettings().sandbox.profile, "off");
    database.setSandboxSettings({
      allowedDomains: ["*.Example.com", "example.com"],
      deniedDomains: ["blocked.example.com"],
      profile: "read_only",
    });
    assert.deepEqual(database.getSettings().sandbox, {
      allowedDomains: ["example.com"],
      deniedDomains: ["blocked.example.com"],
      profile: "read_only",
    });
  } finally {
    database.close();
    await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 });
  }
});

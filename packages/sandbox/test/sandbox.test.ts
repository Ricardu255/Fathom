import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSandboxRuntimeConfig,
  domainMatches,
  normalizeSandboxSettings,
  sandboxBlockedNetworkReason,
  sandboxBlockedToolReason,
} from "../src/index";

test("read_only 拒绝写文件、命令、子 Agent 与记忆写入", () => {
  const settings = normalizeSandboxSettings({ profile: "read_only" });
  for (const name of [
    "write_file",
    "edit_file",
    "run_command",
    "start_background_command",
    "spawn_agent",
    "run_workflow",
    "save_memory",
    "forget_memory",
  ]) {
    assert.match(sandboxBlockedToolReason(settings, name) ?? "", /read_only/u);
  }
  for (const name of ["read_file", "web_fetch", "view_image", "read_document"]) {
    assert.equal(sandboxBlockedToolReason(settings, name), undefined);
  }
});

test("workspace_write 允许写文件与命令，off 不限制", () => {
  const workspace = normalizeSandboxSettings({ profile: "workspace_write" });
  assert.equal(sandboxBlockedToolReason(workspace, "write_file"), undefined);
  assert.equal(sandboxBlockedToolReason(workspace, "run_command"), undefined);
  const off = normalizeSandboxSettings({ profile: "off" });
  assert.equal(sandboxBlockedToolReason(off, "write_file"), undefined);
});

test("网络边界先拒绝 deny，再校验 allow 名单", () => {
  const settings = normalizeSandboxSettings({
    allowedDomains: ["example.com", "*.trusted.dev"],
    deniedDomains: ["blocked.example.com"],
    profile: "read_only",
  });
  assert.equal(sandboxBlockedNetworkReason(settings, "docs.example.com"), undefined);
  assert.match(sandboxBlockedNetworkReason(settings, "api.blocked.example.com") ?? "", /拒绝/u);
  assert.match(sandboxBlockedNetworkReason(settings, "other.com") ?? "", /白名单/u);
  assert.match(sandboxBlockedNetworkReason(settings, "a.trusted.dev") ?? "", /^$/u);

  const emptyAllow = normalizeSandboxSettings({ profile: "read_only" });
  assert.equal(sandboxBlockedNetworkReason(emptyAllow, "other.com"), undefined);
});

test("SRT 配置按 Profile 限制写入，并携带网络与凭据脱敏", () => {
  const readOnly = buildSandboxRuntimeConfig({
    allowedDomains: ["example.com"],
    cwd: "/workspace",
    credentialNames: ["GITHUB_TOKEN"],
    deniedDomains: ["blocked.example.com"],
    profile: "read_only",
    protectedPaths: ["/data"],
  });
  assert.equal(readOnly.filesystem?.allowWrite?.includes("/workspace"), false);
  assert.deepEqual(readOnly.network?.allowedDomains, ["example.com"]);
  assert.deepEqual(readOnly.network?.deniedDomains, ["blocked.example.com"]);
  assert.equal(readOnly.credentials?.envVars?.[0]?.name, "GITHUB_TOKEN");

  const writable = buildSandboxRuntimeConfig({
    allowedDomains: [],
    cwd: "/workspace",
    deniedDomains: [],
    profile: "workspace_write",
    protectedPaths: ["/data"],
  });
  assert.equal(writable.filesystem?.allowWrite?.includes("/workspace"), true);
});

test("域名规范化去重并支持通配符", () => {
  const settings = normalizeSandboxSettings({
    allowedDomains: ["*.Example.com", "example.com", ".example.com", ""],
  });
  assert.deepEqual(settings.allowedDomains, ["example.com"]);
  assert.equal(domainMatches("example.com", "example.com"), true);
  assert.equal(domainMatches("example.com", "a.example.com"), true);
  assert.equal(domainMatches("example.com", "badexample.com"), false);
});

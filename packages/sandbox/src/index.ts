export type SandboxProfile = "off" | "read_only" | "workspace_write";

export {
  buildSandboxRuntimeConfig,
  runSandboxedCommand,
  type SandboxCommandInput,
  type SandboxCommandResult,
} from "./process-sandbox";

export interface SandboxSettings {
  allowedDomains: string[];
  deniedDomains: string[];
  profile: SandboxProfile;
}

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  allowedDomains: [],
  deniedDomains: [],
  profile: "off",
};

const WRITE_TOOLS = new Set(["edit_file", "write_file"]);
const COMMAND_TOOLS = new Set(["run_command", "start_background_command"]);
const AGENT_TOOLS = new Set(["run_workflow", "spawn_agent"]);
const MEMORY_WRITE_TOOLS = new Set(["forget_memory", "save_memory"]);

export function normalizeSandboxSettings(input: {
  allowedDomains?: readonly string[] | undefined;
  deniedDomains?: readonly string[] | undefined;
  profile?: string | undefined;
}): SandboxSettings {
  return {
    allowedDomains: normalizeDomains(input.allowedDomains ?? []),
    deniedDomains: normalizeDomains(input.deniedDomains ?? []),
    profile: normalizeProfile(input.profile),
  };
}

export function normalizeProfile(value: string | undefined): SandboxProfile {
  return value === "read_only" || value === "workspace_write" ? value : "off";
}

/** 返回工具被当前 Profile 拒绝的原因；返回 undefined 表示允许。 */
export function sandboxBlockedToolReason(
  settings: SandboxSettings,
  toolName: string,
): string | undefined {
  if (settings.profile === "off") return undefined;
  if (settings.profile === "read_only") {
    if (WRITE_TOOLS.has(toolName) || COMMAND_TOOLS.has(toolName)) {
      return "沙箱 read_only 模式禁止写文件或执行命令";
    }
    if (AGENT_TOOLS.has(toolName) || MEMORY_WRITE_TOOLS.has(toolName)) {
      return "沙箱 read_only 模式禁止启动子 Agent 或写入记忆";
    }
  }
  return undefined;
}

/** 返回域名被网络边界拒绝的原因；返回 undefined 表示允许。 */
export function sandboxBlockedNetworkReason(
  settings: SandboxSettings,
  hostname: string,
): string | undefined {
  const host = normalizeHost(hostname);
  if (host === "") return "域名为空";
  if (settings.deniedDomains.some((pattern) => domainMatches(pattern, host))) {
    return `沙箱拒绝访问域名 ${host}`;
  }
  if (
    settings.allowedDomains.length > 0 &&
    !settings.allowedDomains.some((pattern) => domainMatches(pattern, host))
  ) {
    return `沙箱域名白名单未包含 ${host}`;
  }
  return undefined;
}

export function domainMatches(pattern: string, hostname: string): boolean {
  const normalizedPattern = normalizeHost(pattern.replace(/^\*\./u, ""));
  const host = normalizeHost(hostname);
  if (normalizedPattern === "" || host === "") return false;
  if (normalizedPattern === "*") return true;
  return host === normalizedPattern || host.endsWith(`.${normalizedPattern}`);
}

export function normalizeDomains(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const domain = normalizeHost(value.replace(/^\*\./u, ""));
    if (domain === "" || seen.has(domain)) continue;
    seen.add(domain);
    result.push(domain);
    if (result.length >= 100) break;
  }
  return result;
}

function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\./u, "");
}

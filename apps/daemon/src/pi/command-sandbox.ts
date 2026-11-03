import { runSandboxedCommand } from "@harness/sandbox";
import type { SandboxCommandRunner } from "@harness/tools";
import type { HarnessConfig } from "../config";
import type { HarnessSettings } from "../storage/database";

export function createCommandSandboxRunner(options: {
  config: HarnessConfig;
  getSettings: () => HarnessSettings;
  logger: { warn(details: Record<string, unknown>, message: string): void };
}): SandboxCommandRunner {
  return async (input) => {
    const settings = options.getSettings();
    if (settings.sandbox.profile === "off" || settings.approvalMode === "full_access") {
      return null;
    }
    try {
      return await runSandboxedCommand({
        allowedDomains: settings.sandbox.allowedDomains,
        command: input.command,
        ...(options.config.sandboxCredentialNames.length === 0
          ? {}
          : { credentialNames: options.config.sandboxCredentialNames }),
        cwd: input.cwd,
        deniedDomains: settings.sandbox.deniedDomains,
        ...(input.onOutput === undefined ? {} : { onOutput: input.onOutput }),
        profile: settings.sandbox.profile,
        protectedPaths: [options.config.dataDir],
        signal: input.signal,
        timeoutMs: input.timeoutMs,
      });
    } catch (error: unknown) {
      options.logger.warn({ err: error }, "SRT 沙箱启动失败");
      throw new Error(
        `SRT 沙箱不可用：${error instanceof Error ? error.message : String(error)}。请切换到完全访问或关闭沙箱 Profile。`,
      );
    }
  };
}

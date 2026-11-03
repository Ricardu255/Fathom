import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SandboxProfile } from "./index";

const MAX_OUTPUT_BYTES = 128 * 1024;

export interface SandboxCommandInput {
  allowedDomains: readonly string[];
  command: string;
  credentialNames?: readonly string[];
  cwd: string;
  deniedDomains: readonly string[];
  onOutput?: (chunk: string) => void;
  profile: SandboxProfile;
  protectedPaths: readonly string[];
  signal?: AbortSignal;
  timeoutMs: number;
}

export interface SandboxCommandResult {
  code: number | null;
  note: string | null;
  stderr: string;
  stdout: string;
}

export function buildSandboxRuntimeConfig(
  input: Omit<SandboxCommandInput, "command" | "onOutput" | "signal" | "timeoutMs">,
): SandboxRuntimeConfig {
  const temporary = tmpdir();
  const writable = input.profile === "workspace_write" ? [input.cwd, temporary] : [temporary];
  return {
    filesystem: {
      denyRead: [...input.protectedPaths],
      allowRead: [input.cwd, temporary],
      allowWrite: writable,
      denyWrite: [...input.protectedPaths],
    },
    network: {
      allowedDomains: [...input.allowedDomains],
      deniedDomains: [...input.deniedDomains],
      ...((input.credentialNames?.length ?? 0) > 0
        ? {
            tlsTerminate: {},
          }
        : {}),
    },
    ...((input.credentialNames?.length ?? 0) > 0
      ? {
          credentials: {
            envVars: input.credentialNames?.map((name) => ({
              mode: "mask" as const,
              name,
            })),
          },
        }
      : {}),
  };
}

let queue: Promise<unknown> = Promise.resolve();

/** 串行持有 SRT 全局代理，避免并发命令串用网络与凭据规则。 */
export async function runSandboxedCommand(
  input: SandboxCommandInput,
): Promise<SandboxCommandResult> {
  const operation = queue.then(async () => {
    input.signal?.throwIfAborted();
    const config = buildSandboxRuntimeConfig(input);
    await SandboxManager.initialize(config);
    const commandId = `fathom-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      const wrapped = await SandboxManager.wrapWithSandbox(
        input.command,
        undefined,
        undefined,
        undefined,
        { commandId, commandText: input.command },
      );
      return await spawnWrapped(wrapped, input);
    } finally {
      await SandboxManager.reset().catch(() => undefined);
    }
  });
  queue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

function spawnWrapped(command: string, input: SandboxCommandInput): Promise<SandboxCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: input.cwd,
      detached: process.platform !== "win32",
      env: process.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    const append = (target: "stderr" | "stdout", chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      const text = chunk.toString("utf8");
      bytes += chunk.byteLength;
      if (target === "stdout") stdout += text;
      else stderr += text;
      input.onOutput?.(text);
    };
    child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
    const kill = () => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // 进程可能已经退出。
        }
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      kill();
    }, input.timeoutMs);
    const onAbort = () => kill();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      if (input.signal?.aborted === true) {
        reject(new Error("命令已取消"));
        return;
      }
      resolve({
        code,
        note: timedOut ? `沙箱超时（${input.timeoutMs}ms）` : signal ? `signal ${signal}` : null,
        stderr: stderr.slice(0, MAX_OUTPUT_BYTES),
        stdout: stdout.slice(0, MAX_OUTPUT_BYTES),
      });
    });
  });
}

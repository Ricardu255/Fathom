import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SandboxProfile } from "@harness/sandbox";

const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_VIEW_BYTES = 64 * 1024;
const DEFAULT_MAX_ACTIVE_PER_SESSION = 4;
const DEFAULT_MAX_ACTIVE_TOTAL = 8;

/** 只继承运行命令所需的宿主变量；API Key、HARNESS_* 与代理凭据不会进入子进程。 */
const COMMAND_ENVIRONMENT_NAMES = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
] as const;

export type BackgroundCommandStatus = "exited" | "failed" | "running" | "stopped";

export interface BackgroundCommandView {
  command: string;
  endedAt: number | null;
  exitCode: number | null;
  id: string;
  name: string;
  sessionId: string;
  startedAt: number;
  status: BackgroundCommandStatus;
  stderr: string;
  stdout: string;
}

export interface BackgroundCommandServiceOptions {
  getApprovalMode?: () => "auto_approve" | "full_access" | "request_approval";
  getSandboxSettings?: () => { profile: SandboxProfile };
  maxActivePerSession?: number;
  maxActiveTotal?: number;
}

interface BackgroundCommandRecord {
  child: ChildProcess;
  command: string;
  endedAt: number | null;
  exitCode: number | null;
  id: string;
  name: string;
  sessionId: string;
  startedAt: number;
  stderr: string;
  stdout: string;
  stopped: boolean;
  outputBytes: number;
  watchdog: ChildProcess | null;
}

export class BackgroundCommandServiceError extends Error {
  public constructor(
    public readonly code: "INVALID" | "LIMIT" | "NOT_FOUND" | "SANDBOX_UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "BackgroundCommandServiceError";
  }
}

export class BackgroundCommandService {
  private readonly commands = new Map<string, BackgroundCommandRecord>();
  private readonly maxActivePerSession: number;
  private readonly maxActiveTotal: number;

  public constructor(private readonly options: BackgroundCommandServiceOptions = {}) {
    this.maxActivePerSession = Math.max(
      1,
      options.maxActivePerSession ?? DEFAULT_MAX_ACTIVE_PER_SESSION,
    );
    this.maxActiveTotal = Math.max(1, options.maxActiveTotal ?? DEFAULT_MAX_ACTIVE_TOTAL);
  }

  public start(input: {
    command: string;
    name?: string | undefined;
    sessionId: string;
    workspaceRoot: string;
  }): BackgroundCommandView {
    const command = input.command.trim();
    if (command === "") {
      throw new BackgroundCommandServiceError("INVALID", "命令不能为空");
    }
    if (command.length > 65_536) {
      throw new BackgroundCommandServiceError("INVALID", "命令过长");
    }
    const sandboxProfile = this.options.getSandboxSettings?.().profile ?? "off";
    const approvalMode = this.options.getApprovalMode?.() ?? "request_approval";
    if (sandboxProfile !== "off" && approvalMode !== "full_access") {
      // 长驻 SRT 进程需要独立 worker 持有全局 sandbox；当前实现不做静默降级。
      throw new BackgroundCommandServiceError(
        "SANDBOX_UNSUPPORTED",
        "沙箱 Profile 下暂不支持后台命令；请改用前台 run_command，或在设置中切换完全访问/关闭沙箱。",
      );
    }
    const running = this.running();
    if (running.length >= this.maxActiveTotal) {
      throw new BackgroundCommandServiceError(
        "LIMIT",
        `后台命令总数已达上限（${this.maxActiveTotal}）`,
      );
    }
    if (
      running.filter((record) => record.sessionId === input.sessionId).length >=
      this.maxActivePerSession
    ) {
      throw new BackgroundCommandServiceError(
        "LIMIT",
        `当前 Session 的后台命令已达上限（${this.maxActivePerSession}）`,
      );
    }

    const id = randomUUID();
    const child = spawn(command, {
      cwd: input.workspaceRoot,
      detached: process.platform !== "win32",
      env: commandEnvironment(),
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const record: BackgroundCommandRecord = {
      child,
      command,
      endedAt: null,
      exitCode: null,
      id,
      name: input.name?.trim() || command.slice(0, 60),
      outputBytes: 0,
      sessionId: input.sessionId,
      startedAt: Date.now(),
      stderr: "",
      stdout: "",
      stopped: false,
      watchdog: startWatchdog(child.pid),
    };
    this.commands.set(id, record);
    child.stdout?.on("data", (chunk: Buffer) => this.append(record, "stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.append(record, "stderr", chunk));
    child.once("error", () => {
      record.endedAt = Date.now();
      record.exitCode = null;
      killProcessTree(record.child.pid);
      stopWatchdog(record);
    });
    child.once("close", (code) => {
      record.endedAt = Date.now();
      record.exitCode = code;
      // 正常退出也清理残留子进程；Shell 可能没有把信号转发给 dev server。
      killProcessTree(record.child.pid);
      stopWatchdog(record);
    });
    return this.toView(record);
  }

  public list(sessionId: string): BackgroundCommandView[] {
    return [...this.commands.values()]
      .filter((record) => record.sessionId === sessionId)
      .sort((left, right) => right.startedAt - left.startedAt)
      .map((record) => this.toView(record));
  }

  public get(sessionId: string, id: string): BackgroundCommandView {
    return this.toView(this.require(sessionId, id));
  }

  public stop(sessionId: string, id: string): BackgroundCommandView {
    const record = this.require(sessionId, id);
    if (!isRunning(record)) return this.toView(record);
    record.stopped = true;
    killProcessTree(record.child.pid);
    stopWatchdog(record);
    record.endedAt = Date.now();
    return this.toView(record);
  }

  public stopSession(sessionId: string): void {
    for (const record of this.commands.values()) {
      if (record.sessionId === sessionId && isRunning(record)) {
        record.stopped = true;
        killProcessTree(record.child.pid);
        stopWatchdog(record);
      }
    }
  }

  public stopAll(): void {
    for (const record of this.commands.values()) {
      if (isRunning(record)) killProcessTree(record.child.pid);
      stopWatchdog(record);
    }
    this.commands.clear();
  }

  private running(): BackgroundCommandRecord[] {
    return [...this.commands.values()].filter(isRunning);
  }

  private append(
    record: BackgroundCommandRecord,
    stream: "stderr" | "stdout",
    chunk: Buffer,
  ): void {
    if (record.outputBytes >= MAX_CAPTURE_BYTES) return;
    const remaining = MAX_CAPTURE_BYTES - record.outputBytes;
    const text = chunk.subarray(0, remaining).toString("utf8");
    record[stream] += text;
    record.outputBytes += Math.min(chunk.byteLength, remaining);
    if (record.outputBytes >= MAX_CAPTURE_BYTES) {
      record.stdout = record.stdout.slice(-MAX_CAPTURE_BYTES);
      record.stderr = record.stderr.slice(-MAX_CAPTURE_BYTES);
    }
  }

  private require(sessionId: string, id: string): BackgroundCommandRecord {
    const record = this.commands.get(id);
    if (record === undefined || record.sessionId !== sessionId) {
      throw new BackgroundCommandServiceError("NOT_FOUND", "后台命令不存在");
    }
    return record;
  }

  private toView(record: BackgroundCommandRecord): BackgroundCommandView {
    const running = isRunning(record);
    return {
      command: record.command,
      endedAt: record.endedAt,
      exitCode: record.exitCode,
      id: record.id,
      name: record.name,
      sessionId: record.sessionId,
      startedAt: record.startedAt,
      status: record.stopped
        ? "stopped"
        : running
          ? "running"
          : record.exitCode === 0
            ? "exited"
            : "failed",
      stderr: record.stderr.slice(-MAX_VIEW_BYTES),
      stdout: record.stdout.slice(-MAX_VIEW_BYTES),
    };
  }
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of COMMAND_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function isRunning(record: BackgroundCommandRecord): boolean {
  return record.child.exitCode === null && record.child.signalCode === null;
}

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // 进程可能已经退出。
  }
}

/**
 * 独立 watchdog：daemon 正常停止时发送 release 后退出；daemon 崩溃时
 * IPC 断开且没有 release，watchdog 会杀掉目标进程树，避免 dev server 泄漏。
 */
function startWatchdog(targetPid: number | undefined): ChildProcess | null {
  if (targetPid === undefined) return null;
  const script = `
const { spawn } = require("node:child_process");
const parentPid = Number(process.argv[1]);
const targetPid = Number(process.argv[2]);
let released = false;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const killTarget = () => {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(targetPid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      process.kill(-targetPid, "SIGKILL");
    }
  } catch {}
};
const timer = setInterval(() => {
  if (!alive(parentPid) || !alive(targetPid)) {
    if (!released) killTarget();
    process.exit(0);
  }
}, 1000);
process.on("message", (message) => {
  if (message && message.type === "release") {
    released = true;
    clearInterval(timer);
    process.exit(0);
  }
});
process.on("disconnect", () => {
  if (!released) killTarget();
  process.exit(0);
});
`;
  try {
    const watchdog = spawn(
      process.execPath,
      ["-e", script, String(process.pid), String(targetPid)],
      {
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    watchdog.unref();
    return watchdog;
  } catch {
    return null;
  }
}

function stopWatchdog(record: BackgroundCommandRecord): void {
  const watchdog = record.watchdog;
  if (watchdog === null) return;
  record.watchdog = null;
  try {
    if (watchdog.connected) watchdog.send({ type: "release" });
    watchdog.disconnect();
  } catch {
    // watchdog 可能已经退出。
  }
  watchdog.unref();
}

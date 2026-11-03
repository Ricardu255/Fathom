import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Play, Square, Terminal, X } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "../api/client";
import { backgroundCommandsQueryOptions, queryKeys } from "../api/queries";
import type { BackgroundCommandView } from "../api/types";

const STATUS_LABEL: Record<BackgroundCommandView["status"], string> = {
  exited: "已退出",
  failed: "失败",
  running: "运行中",
  stopped: "已停止",
};

export function BackgroundCommandDrawer({
  onClose,
  sessionId,
}: {
  onClose: () => void;
  sessionId: string;
}) {
  const queryClient = useQueryClient();
  const [command, setCommand] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const commandsQuery = useQuery(backgroundCommandsQueryOptions(sessionId));

  const invalidate = async () => {
    await queryClient.invalidateQueries({
      queryKey: queryKeys.backgroundCommands(sessionId),
    });
  };

  const startMutation = useMutation({
    mutationFn: (input: { command: string; name?: string }) =>
      apiFetch<BackgroundCommandView>(
        `/api/sessions/${encodeURIComponent(sessionId)}/background-commands`,
        { body: JSON.stringify(input), method: "POST" },
      ),
    onSuccess: async () => {
      setCommand("");
      setName("");
      setError(null);
      await invalidate();
    },
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "启动后台命令失败");
    },
  });

  const stopMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<BackgroundCommandView>(
        `/api/sessions/${encodeURIComponent(sessionId)}/background-commands/${encodeURIComponent(id)}/stop`,
        { method: "POST" },
      ),
    onSuccess: invalidate,
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "停止后台命令失败");
    },
  });

  const commands = commandsQuery.data ?? [];

  return (
    <div className="workspace-drawer" role="dialog" aria-label="后台命令">
      <div className="workspace-drawer-head">
        <div>
          <h2>后台命令</h2>
          <p>运行 dev server、watch、长测试等；输出保留最近 256KB。</p>
        </div>
        <button aria-label="关闭后台命令" className="dialog-close" onClick={onClose} type="button">
          <X size={16} />
        </button>
      </div>
      <div className="background-command-body">
        <section className="background-command-form">
          <label className="field">
            <span>名称（可选）</span>
            <input
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如 dev server"
              value={name}
            />
          </label>
          <label className="field">
            <span>命令</span>
            <input
              aria-label="后台命令"
              maxLength={65_536}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="pnpm dev"
              value={command}
            />
          </label>
          <button
            className="btn btn-primary"
            disabled={command.trim() === "" || startMutation.isPending}
            onClick={() =>
              startMutation.mutate({
                command: command.trim(),
                ...(name.trim() === "" ? {} : { name: name.trim() }),
              })
            }
            type="button"
          >
            {startMutation.isPending ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
            启动
          </button>
        </section>

        {error !== null ? <div className="inline-error">{error}</div> : null}
        {commandsQuery.error !== null ? (
          <div className="inline-error">{commandsQuery.error.message}</div>
        ) : null}

        <section className="background-command-list">
          {commands.length === 0 ? (
            <div className="workspace-placeholder">
              <Terminal size={20} /> 还没有后台命令。
            </div>
          ) : (
            commands.map((item) => (
              <article className="background-command-card" key={item.id}>
                <div className="background-command-card-head">
                  <span className={`background-status status-${item.status}`}>
                    {STATUS_LABEL[item.status]}
                  </span>
                  <span className="background-command-name">{item.name}</span>
                  <span className="background-command-meta">
                    {new Date(item.startedAt).toLocaleTimeString()}
                    {item.exitCode === null ? "" : ` · exit ${item.exitCode}`}
                  </span>
                  {item.status === "running" ? (
                    <button
                      className="btn btn-ghost danger"
                      disabled={stopMutation.isPending}
                      onClick={() => stopMutation.mutate(item.id)}
                      type="button"
                    >
                      <Square size={12} /> 停止
                    </button>
                  ) : null}
                </div>
                <code className="background-command-line">$ {item.command}</code>
                {item.stdout !== "" || item.stderr !== "" ? (
                  <pre className="background-command-output">
                    {item.stdout.slice(-8_000)}
                    {item.stderr === "" ? "" : `\n[stderr]\n${item.stderr.slice(-4_000)}`}
                  </pre>
                ) : null}
              </article>
            ))
          )}
        </section>
      </div>
    </div>
  );
}

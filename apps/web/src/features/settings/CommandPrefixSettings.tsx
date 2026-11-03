import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { apiFetch } from "../../api/client";
import { commandPrefixesQueryOptions, queryKeys } from "../../api/queries";

export function CommandPrefixSettings() {
  const queryClient = useQueryClient();
  const prefixesQuery = useQuery(commandPrefixesQueryOptions());
  const removeMutation = useMutation({
    mutationFn: (prefix: string) =>
      apiFetch<string[]>("/api/settings/command-prefixes", {
        body: JSON.stringify({ prefix }),
        method: "DELETE",
      }),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.commandPrefixes, next);
    },
  });
  const prefixes = prefixesQuery.data ?? [];

  return (
    <div className="command-prefixes">
      <div className="command-prefixes-head">
        <strong>已允许的命令前缀</strong>
        <span>仅对逐 token 匹配的简单命令生效；高风险命令始终逐次审批。</span>
      </div>
      {prefixesQuery.isPending ? (
        <div className="settings-skeleton">读取中…</div>
      ) : prefixes.length === 0 ? (
        <p className="settings-hint">还没有持久化的命令授权。</p>
      ) : (
        <div className="command-prefix-list">
          {prefixes.map((prefix) => (
            <div className="command-prefix-row" key={prefix}>
              <code>{prefix}</code>
              <button
                aria-label={`撤销命令授权 ${prefix}`}
                className="session-action"
                disabled={removeMutation.isPending}
                onClick={() => removeMutation.mutate(prefix)}
                type="button"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {removeMutation.isError ? <p className="settings-inline-error">撤销失败，请重试。</p> : null}
    </div>
  );
}

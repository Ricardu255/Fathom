import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, LogIn, LogOut, X } from "lucide-react";
import { useEffect, useState } from "react";
import { apiFetch } from "../../api/client";
import { oauthProvidersQueryOptions, queryKeys } from "../../api/queries";
import type { OAuthEventView, OAuthLoginView, OAuthProviderView } from "../../api/types";

export function ProviderOAuthSettings() {
  const queryClient = useQueryClient();
  const providersQuery = useQuery(oauthProvidersQueryOptions());
  const [loginId, setLoginId] = useState<string | null>(null);
  const [promptValue, setPromptValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sessionQuery = useQuery({
    enabled: loginId !== null,
    queryFn: () => apiFetch<OAuthLoginView>(`/api/providers/oauth/${loginId}`),
    queryKey: ["providers", "oauth", loginId],
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 1_000 : false),
  });
  const session = sessionQuery.data;
  const provider = providersQuery.data?.find((item) => item.id === session?.providerId);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在 prompt 切换时重置输入
  useEffect(() => {
    const prompt = session?.prompt;
    if (prompt === null || prompt === undefined) {
      setPromptValue("");
      return;
    }
    setPromptValue(prompt.type === "select" ? (prompt.options?.[0]?.id ?? "") : "");
  }, [session?.prompt?.id]);

  useEffect(() => {
    if (session?.status !== "success") return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.oauthProviders }),
      queryClient.invalidateQueries({ queryKey: queryKeys.modelCatalog }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
    ]);
  }, [queryClient, session?.status]);

  const startMutation = useMutation({
    mutationFn: (providerId: string) =>
      apiFetch<OAuthLoginView>(`/api/providers/${encodeURIComponent(providerId)}/oauth`, {
        method: "POST",
      }),
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "启动 OAuth 登录失败");
    },
    onSuccess: (view) => {
      setError(null);
      setLoginId(view.id);
    },
  });

  const answerMutation = useMutation({
    mutationFn: (input: { promptId: string; value: string }) =>
      apiFetch<OAuthLoginView>(`/api/providers/oauth/${loginId}/prompt`, {
        body: JSON.stringify(input),
        method: "POST",
      }),
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "提交登录信息失败");
    },
    onSuccess: () => {
      setPromptValue("");
      void queryClient.invalidateQueries({ queryKey: ["providers", "oauth", loginId] });
    },
  });

  const cancel = async () => {
    if (loginId === null) return;
    await apiFetch<void>(`/api/providers/oauth/${loginId}`, { method: "DELETE" }).catch(
      () => undefined,
    );
    setLoginId(null);
    setError(null);
  };

  const logoutMutation = useMutation({
    mutationFn: (providerId: string) =>
      apiFetch<void>(`/api/providers/${encodeURIComponent(providerId)}/oauth/credential`, {
        method: "DELETE",
      }),
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "退出 OAuth 登录失败");
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.oauthProviders });
      await queryClient.invalidateQueries({ queryKey: queryKeys.modelCatalog });
    },
  });

  return (
    <div className="oauth-providers">
      <div className="custom-providers-head">
        <div>
          <strong>OAuth 登录</strong>
          <span>使用 Provider 官方账号登录，凭据由本机 pi CredentialStore 保存。</span>
        </div>
      </div>
      {providersQuery.isPending ? (
        <div className="settings-skeleton">正在读取 OAuth Provider…</div>
      ) : providersQuery.data?.length === 0 ? (
        <p className="settings-hint">当前 Provider 目录没有可用的 OAuth 登录。</p>
      ) : (
        <div className="oauth-provider-list">
          {providersQuery.data?.map((item) => (
            <OAuthProviderRow
              key={item.id}
              loginPending={startMutation.isPending}
              loggingOut={logoutMutation.isPending}
              onLogin={() => startMutation.mutate(item.id)}
              onLogout={() => logoutMutation.mutate(item.id)}
              provider={item}
            />
          ))}
        </div>
      )}
      {error !== null ? <p className="settings-inline-error">{error}</p> : null}

      {loginId !== null ? (
        <div className="dialog-backdrop">
          <div
            aria-label={`${provider?.name ?? "Provider"} OAuth 登录`}
            aria-modal="true"
            className="dialog-panel oauth-dialog"
            role="dialog"
          >
            <div className="dialog-head">
              <div>
                <h2>{provider?.name ?? "Provider"} 登录</h2>
                <p>{provider?.loginLabel ?? "完成授权以连接账号"}</p>
              </div>
              <button
                aria-label="取消登录"
                className="dialog-close"
                onClick={() => void cancel()}
                type="button"
              >
                <X size={16} />
              </button>
            </div>
            <div className="dialog-body">
              {session === undefined ? (
                <div className="oauth-pending">
                  <Loader2 className="spin" size={15} /> 正在启动登录…
                </div>
              ) : (
                <>
                  <OAuthEvents events={session.events} />
                  {session.status === "pending" && session.prompt !== null ? (
                    <form
                      className="oauth-prompt"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (promptValue.trim() === "") return;
                        answerMutation.mutate({
                          promptId: session.prompt?.id ?? "",
                          value: promptValue,
                        });
                      }}
                    >
                      <div className="oauth-prompt-field">
                        <span>{session.prompt.message}</span>
                        {session.prompt.type === "select" ? (
                          <select
                            aria-label={session.prompt.message}
                            onChange={(event) => setPromptValue(event.target.value)}
                            value={promptValue}
                          >
                            {session.prompt.options?.map((option) => (
                              <option key={option.id} value={option.id}>
                                {option.label}
                                {option.description ? ` · ${option.description}` : ""}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            aria-label={session.prompt.message}
                            autoComplete="off"
                            onChange={(event) => setPromptValue(event.target.value)}
                            placeholder={session.prompt.placeholder}
                            type={session.prompt.type === "secret" ? "password" : "text"}
                            value={promptValue}
                          />
                        )}
                      </div>
                      <button
                        className="btn btn-primary"
                        disabled={answerMutation.isPending || promptValue.trim() === ""}
                        type="submit"
                      >
                        {answerMutation.isPending ? "提交中…" : "继续"}
                      </button>
                    </form>
                  ) : null}
                  {session.status === "pending" ? (
                    <div className="oauth-pending">
                      <Loader2 className="spin" size={14} /> 等待授权或在浏览器中完成登录…
                    </div>
                  ) : session.status === "success" ? (
                    <p className="settings-notice success">登录成功，可以关闭窗口。</p>
                  ) : session.status === "error" ? (
                    <p className="settings-inline-error">{session.error ?? "登录失败"}</p>
                  ) : (
                    <p className="settings-hint">登录已取消。</p>
                  )}
                </>
              )}
            </div>
            <div className="dialog-actions">
              <span className="dialog-spacer" />
              <button className="btn btn-ghost" onClick={() => void cancel()} type="button">
                {session?.status === "success" ? "关闭" : "取消登录"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function OAuthProviderRow(props: {
  loginPending: boolean;
  loggingOut: boolean;
  onLogin: () => void;
  onLogout: () => void;
  provider: OAuthProviderView;
}) {
  return (
    <div className="oauth-provider-row">
      <div>
        <strong>{props.provider.name}</strong>
        <span>{props.provider.configured ? "已登录" : "未登录"}</span>
      </div>
      {props.provider.configured ? (
        <button
          className="btn btn-ghost"
          disabled={props.loggingOut}
          onClick={props.onLogout}
          type="button"
        >
          <LogOut size={13} /> 退出登录
        </button>
      ) : (
        <button
          className="btn btn-ghost"
          disabled={props.loginPending}
          onClick={props.onLogin}
          type="button"
        >
          <LogIn size={13} /> 登录
        </button>
      )}
    </div>
  );
}

function OAuthEvents({ events }: { events: OAuthEventView[] }) {
  if (events.length === 0) return null;
  return (
    <div className="oauth-events">
      {events.map((event, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: OAuth 事件只追加，没有稳定业务 ID
        <div className="oauth-event" key={`${event.type}-${index}`}>
          {event.type === "auth_url" ? (
            <>
              <a href={event.url} rel="noopener noreferrer" target="_blank">
                打开授权页面 <ExternalLink size={11} />
              </a>
              {event.instructions !== undefined ? <span>{event.instructions}</span> : null}
            </>
          ) : event.type === "device_code" ? (
            <>
              <strong>{event.userCode}</strong>
              <a href={event.verificationUri} rel="noopener noreferrer" target="_blank">
                {event.verificationUri}
              </a>
            </>
          ) : event.type === "info" ? (
            <>
              <span>{event.message}</span>
              {event.links?.map((link) => (
                <a href={link.url} key={link.url} rel="noopener noreferrer" target="_blank">
                  {link.label ?? link.url}
                </a>
              ))}
            </>
          ) : (
            <span>{event.message}</span>
          )}
        </div>
      ))}
    </div>
  );
}

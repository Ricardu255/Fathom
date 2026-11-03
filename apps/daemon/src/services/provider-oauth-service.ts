import { randomUUID } from "node:crypto";
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export class ProviderOAuthError extends Error {
  public constructor(
    public readonly code: "INVALID" | "NOT_FOUND" | "NOT_SUPPORTED" | "BUSY",
    message: string,
  ) {
    super(message);
    this.name = "ProviderOAuthError";
  }
}

interface PendingPrompt {
  id: string;
  prompt: AuthPrompt;
  reject: (error: Error) => void;
  resolve: (value: string) => void;
}

interface OAuthSession {
  controller: AbortController;
  events: AuthEvent[];
  id: string;
  pending: PendingPrompt | null;
  providerId: string;
  status: "cancelled" | "error" | "pending" | "success";
  error: string | null;
}

export interface OAuthPromptView {
  id: string;
  message: string;
  options?: readonly { description?: string | undefined; id: string; label: string }[];
  placeholder?: string;
  type: AuthPrompt["type"];
}

export interface OAuthLoginView {
  error: string | null;
  events: AuthEvent[];
  id: string;
  prompt: OAuthPromptView | null;
  providerId: string;
  status: OAuthSession["status"];
}

export interface OAuthProviderView {
  configured: boolean;
  id: string;
  loginLabel: string;
  name: string;
}

export class ProviderOAuthService {
  private readonly sessions = new Map<string, OAuthSession>();
  private readonly activeByProvider = new Map<string, string>();

  public constructor(
    private readonly modelRuntime: ModelRuntime,
    private readonly isMock: () => boolean = () => false,
  ) {}

  public async listProviders(): Promise<OAuthProviderView[]> {
    const providers = this.modelRuntime
      .getProviders()
      .filter((provider) => provider.auth.oauth !== undefined);
    return Promise.all(
      providers.map(async (provider) => {
        const auth = this.isMock()
          ? undefined
          : await this.modelRuntime.getAuth(provider.id).catch(() => undefined);
        return {
          configured: auth !== undefined,
          id: provider.id,
          loginLabel: provider.auth.oauth?.loginLabel ?? `使用 ${provider.name} 登录`,
          name: provider.name,
        };
      }),
    );
  }

  public async start(providerId: string): Promise<OAuthLoginView> {
    const provider = this.modelRuntime.getProvider(providerId);
    if (provider === undefined) {
      throw new ProviderOAuthError("NOT_FOUND", "Provider 不存在");
    }
    if (provider.auth.oauth === undefined) {
      throw new ProviderOAuthError("NOT_SUPPORTED", "该 Provider 不支持 OAuth 登录");
    }
    const activeId = this.activeByProvider.get(providerId);
    if (activeId !== undefined) {
      const current = this.sessions.get(activeId);
      if (current !== undefined && current.status === "pending") return this.view(current);
    }

    const controller = new AbortController();
    const session: OAuthSession = {
      controller,
      error: null,
      events: [],
      id: randomUUID(),
      pending: null,
      providerId,
      status: "pending",
    };
    this.sessions.set(session.id, session);
    this.activeByProvider.set(providerId, session.id);
    void this.run(session);
    return this.view(session);
  }

  public get(loginId: string): OAuthLoginView {
    const session = this.sessions.get(loginId);
    if (session === undefined) throw new ProviderOAuthError("NOT_FOUND", "登录会话不存在");
    return this.view(session);
  }

  public answer(loginId: string, promptId: string, value: string): OAuthLoginView {
    const session = this.sessions.get(loginId);
    if (session === undefined) throw new ProviderOAuthError("NOT_FOUND", "登录会话不存在");
    const pending = session.pending;
    if (pending === null || pending.id !== promptId) {
      throw new ProviderOAuthError("INVALID", "登录提示已失效");
    }
    session.pending = null;
    pending.resolve(value);
    return this.view(session);
  }

  public cancel(loginId: string): OAuthLoginView {
    const session = this.sessions.get(loginId);
    if (session === undefined) throw new ProviderOAuthError("NOT_FOUND", "登录会话不存在");
    if (session.status === "pending") {
      session.status = "cancelled";
      session.controller.abort();
      session.pending?.reject(new Error("登录已取消"));
      session.pending = null;
    }
    this.activeByProvider.delete(session.providerId);
    return this.view(session);
  }

  public async logout(providerId: string): Promise<void> {
    await this.modelRuntime.logout(providerId);
  }

  private async run(session: OAuthSession): Promise<void> {
    try {
      await this.modelRuntime.login(session.providerId, "oauth", this.interaction(session), {
        agentName: "Fathom",
      });
      session.status = "success";
      session.events.push({ message: "登录成功。", type: "info" });
    } catch (error: unknown) {
      if (session.status !== "cancelled") {
        session.status = "error";
        session.error = error instanceof Error ? error.message : "OAuth 登录失败";
      }
    } finally {
      session.pending = null;
      this.activeByProvider.delete(session.providerId);
    }
  }

  private interaction(session: OAuthSession): AuthInteraction {
    return {
      notify: (event) => {
        session.events.push(event);
      },
      prompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          if (session.controller.signal.aborted) {
            reject(new Error("登录已取消"));
            return;
          }
          const pending: PendingPrompt = {
            id: randomUUID(),
            prompt,
            reject,
            resolve,
          };
          session.pending = pending;
          prompt.signal?.addEventListener(
            "abort",
            () => {
              if (session.pending === pending) session.pending = null;
              reject(new Error("登录提示已取消"));
            },
            { once: true },
          );
        }),
      signal: session.controller.signal,
    };
  }

  private view(session: OAuthSession): OAuthLoginView {
    const pending = session.pending;
    return {
      error: session.error,
      events: session.events,
      id: session.id,
      prompt:
        pending === null
          ? null
          : {
              id: pending.id,
              message: pending.prompt.message,
              ...(pending.prompt.type === "select" ? { options: pending.prompt.options } : {}),
              ...(pending.prompt.type === "text" ||
              pending.prompt.type === "secret" ||
              pending.prompt.type === "manual_code"
                ? pending.prompt.placeholder === undefined
                  ? {}
                  : { placeholder: pending.prompt.placeholder }
                : {}),
              type: pending.prompt.type,
            },
      providerId: session.providerId,
      status: session.status,
    };
  }
}

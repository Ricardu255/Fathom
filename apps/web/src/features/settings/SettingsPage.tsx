import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Cpu,
  HardDrive,
  KeyRound,
  Monitor,
  Moon,
  Palette,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
} from "lucide-react";
import { useState } from "react";
import { ApiError, apiFetch } from "../../api/client";
import { queryKeys, settingsQueryOptions } from "../../api/queries";
import type {
  HarnessSettings,
  ModelChoice,
  ProviderChoice,
  SaveModelSettingsInput,
} from "../../api/types";
import { getThemeMode, setThemeMode, type ThemeMode } from "../../theme";
import { CommandPrefixSettings } from "./CommandPrefixSettings";
import { CustomProviderSettings } from "./CustomProviderSettings";
import { ProviderOAuthSettings } from "./ProviderOAuthSettings";
import { SandboxSettings } from "./SandboxSettings";
import { SkillSettings } from "./SkillSettings";
import { StorageSettings } from "./StorageSettings";

const THEMES: Array<{ icon: typeof Sun; label: string; value: ThemeMode }> = [
  { icon: Sun, label: "奶白纸面", value: "light" },
  { icon: Moon, label: "墨夜深色", value: "dark" },
  { icon: Monitor, label: "跟随系统", value: "system" },
];

export function SettingsPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(settingsQueryOptions());
  const settings = settingsQuery.data;
  const [theme, setTheme] = useState<ThemeMode>(() => getThemeMode());
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const [formVersion, setFormVersion] = useState(0);

  const approvalMutation = useMutation({
    mutationFn: (approvalMode: HarnessSettings["approvalMode"]) =>
      apiFetch<HarnessSettings>("/api/settings", {
        body: JSON.stringify({ approvalMode }),
        method: "PUT",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });

  const saveMutation = useMutation({
    mutationFn: (input: SaveModelSettingsInput) =>
      apiFetch<HarnessSettings>("/api/settings/model", {
        body: JSON.stringify(input),
        method: "PUT",
      }),
    onError: (error: unknown) => {
      setNotice({
        kind: "error",
        text: error instanceof ApiError ? error.message : "保存模型设置失败",
      });
    },
    onSuccess: async (next) => {
      setNotice({ kind: "success", text: "模型设置已保存，从下一个新对话开始生效。" });
      setFormVersion((value) => value + 1);
      queryClient.setQueryData(queryKeys.settings, next);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });

  const applyTheme = (next: ThemeMode) => {
    setTheme(next);
    setThemeMode(next);
  };

  return (
    <div className="settings-page">
      <div className="settings-scroll">
        <div className="settings-container">
          <header className="settings-header">
            <div className="settings-eyebrow">Preferences</div>
            <h1>设置</h1>
            <p>调整外观、工具审批与模型连接。所有配置只保存在这台设备上。</p>
          </header>

          <div className="settings-layout">
            <nav className="settings-nav" aria-label="设置分区">
              <a href="#appearance">
                <Palette size={15} />
                外观
              </a>
              <a href="#approval">
                <ShieldCheck size={15} />
                工具审批
              </a>
              <a href="#sandbox">
                <ShieldAlert size={15} />
                沙箱
              </a>
              <a href="#skills">
                <Sparkles size={15} />
                Skills
              </a>
              <a href="#model">
                <Cpu size={15} />
                模型与 API
              </a>
              <a href="#storage">
                <HardDrive size={15} />
                存储位置
              </a>
            </nav>

            <div className="settings-sections">
              <section className="settings-section" id="appearance">
                <div className="settings-section-head">
                  <h2>外观</h2>
                  <p>界面会立即切换，不需要重启客户端。</p>
                </div>
                <fieldset className="theme-options">
                  <legend className="sr-only">主题</legend>
                  {THEMES.map((option) => {
                    const Icon = option.icon;
                    return (
                      <button
                        aria-pressed={theme === option.value}
                        className={`theme-option${theme === option.value ? " active" : ""}`}
                        key={option.value}
                        onClick={() => applyTheme(option.value)}
                        type="button"
                      >
                        <span className="theme-option-icon">
                          <Icon size={17} />
                        </span>
                        <span>{option.label}</span>
                        {theme === option.value ? (
                          <Check className="theme-check" size={14} />
                        ) : null}
                      </button>
                    );
                  })}
                </fieldset>
              </section>

              <section className="settings-section" id="approval">
                <div className="settings-section-head">
                  <h2>工具审批</h2>
                  <p>写文件、修改代码与执行命令前是否要求你确认。</p>
                </div>
                <div className="approval-options" role="radiogroup" aria-label="工具审批模式">
                  <ApprovalOption
                    active={settings?.approvalMode === "request_approval"}
                    description="每一次有副作用的操作都暂停，等待你批准。"
                    label="逐次审批"
                    onSelect={() => approvalMutation.mutate("request_approval")}
                  />
                  <ApprovalOption
                    active={settings?.approvalMode === "auto_approve"}
                    description="文件操作自动执行；Shell 先由独立模型复核，不确定时转人工。"
                    label="自动批准"
                    onSelect={() => approvalMutation.mutate("auto_approve")}
                  />
                  <ApprovalOption
                    active={settings?.approvalMode === "full_access"}
                    description="自动执行文件、Shell 与外部工具；路径边界和计划模式仍然生效。"
                    label="完全访问"
                    onSelect={() => approvalMutation.mutate("full_access")}
                  />
                </div>
                {approvalMutation.isError ? (
                  <p className="settings-inline-error">审批模式保存失败，请重试。</p>
                ) : null}
                <CommandPrefixSettings />
              </section>

              <section className="settings-section" id="sandbox">
                <div className="settings-section-head">
                  <h2>沙箱</h2>
                  <p>限制文件与网络边界；设置保存在本机，工具调用立即生效。</p>
                </div>
                {settings === undefined ? (
                  <div className="settings-skeleton">正在读取本机配置…</div>
                ) : (
                  <SandboxSettings settings={settings} />
                )}
              </section>

              <section className="settings-section" id="skills">
                <div className="settings-section-head">
                  <h2>Skills</h2>
                  <p>按需加载的 SKILL.md 能力；同名 Skill 按 system → global → project 覆盖。</p>
                </div>
                <SkillSettings />
              </section>

              <section className="settings-section" id="model">
                <div className="settings-section-head">
                  <h2>模型与 API</h2>
                  <p>连接你自己的模型账号。API Key 只写入本机数据目录，保存后不再回显。</p>
                </div>

                {settingsQuery.isPending ? (
                  <div className="settings-skeleton">正在读取本机配置…</div>
                ) : settingsQuery.isError || settings === undefined ? (
                  <div className="settings-inline-error">
                    无法读取设置，请确认 daemon 正在运行。
                  </div>
                ) : (
                  <ModelSettingsForm
                    key={`${settings.providerId}:${settings.model}:${settings.apiKeySource ?? "none"}:${formVersion}`}
                    isSaving={saveMutation.isPending}
                    notice={notice}
                    onClearNotice={() => setNotice(null)}
                    onSave={(input) => {
                      setNotice(null);
                      saveMutation.mutate(input);
                    }}
                    settings={settings}
                  />
                )}
                <CustomProviderSettings />
                <ProviderOAuthSettings />
              </section>

              <section className="settings-section" id="storage">
                <div className="settings-section-head">
                  <h2>存储位置</h2>
                  <p>
                    自定义数据与缓存目录。对话事件、索引、文献与模型设置保存在本机数据目录， Fathom
                    不会把工作区内容上传到自有服务器。
                  </p>
                </div>
                <StorageSettings />
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelSettingsForm(props: {
  isSaving: boolean;
  notice: { kind: "error" | "success"; text: string } | null;
  onClearNotice: () => void;
  onSave: (input: SaveModelSettingsInput) => void;
  settings: HarnessSettings;
}) {
  const { settings } = props;
  const [providerId, setProviderId] = useState(settings.providerId);
  const [modelId, setModelId] = useState(settings.model);
  const [thinkingLevel, setThinkingLevel] = useState(settings.thinkingLevel);
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [testNotice, setTestNotice] = useState<{
    kind: "error" | "success";
    text: string;
  } | null>(null);

  const modelsQuery = useQuery({
    enabled: providerId !== "" && providerId !== settings.providerId,
    queryFn: () =>
      apiFetch<{ models: ModelChoice[] }>(
        `/api/settings/models?providerId=${encodeURIComponent(providerId)}`,
      ),
    queryKey: ["settings", "models", providerId],
  });

  const providers = settings.providers;
  const currentModels =
    providerId === settings.providerId ? settings.models : (modelsQuery.data?.models ?? []);
  const selectedModel =
    currentModels.find((model) => model.id === modelId)?.id ?? currentModels[0]?.id ?? modelId;
  const selectedModelInfo = currentModels.find((model) => model.id === selectedModel);
  const thinkingLevels = selectedModelInfo?.thinkingLevels ?? ["off"];
  const effectiveThinkingLevel = thinkingLevels.includes(thinkingLevel)
    ? thinkingLevel
    : (thinkingLevels[0] ?? "off");
  const selectedProvider =
    providers.find((provider) => provider.id === providerId)?.name ?? settings.providerName;
  const canSave =
    providerId !== "" &&
    selectedModel !== "" &&
    (settings.apiKeyConfigured || apiKey.trim() !== "");

  const save = (clearApiKey?: boolean) =>
    props.onSave({
      ...(clearApiKey === true ? { clearApiKey: true } : {}),
      apiKey,
      modelId: selectedModel,
      providerId,
      thinkingLevel: effectiveThinkingLevel,
    });

  const testConnection = async () => {
    setTesting(true);
    setTestNotice(null);
    try {
      const result = await apiFetch<{ latencyMs: number; model: string }>("/api/models/test", {
        body: JSON.stringify({ apiKey, modelId: selectedModel, providerId }),
        method: "POST",
      });
      setTestNotice({
        kind: "success",
        text: `连接成功：${result.model} · ${result.latencyMs}ms`,
      });
    } catch (cause: unknown) {
      setTestNotice({
        kind: "error",
        text: cause instanceof Error ? cause.message : "连接测试失败",
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="model-settings">
      <div className="model-status-line">
        <span className={`model-status-dot${settings.apiKeyConfigured ? "" : " unconfigured"}`} />
        <span>
          {selectedProvider} · {selectedModel}
        </span>
        <span className="model-status-meta">
          {settings.apiKeySource === "credentials"
            ? "已保存 API Key"
            : settings.apiKeySource === "environment"
              ? "使用环境变量 API Key"
              : "未配置 API Key"}
        </span>
      </div>

      <div className="settings-field-grid">
        <label className="settings-field">
          <span>Provider</span>
          <select
            onChange={(event) => {
              setProviderId(event.target.value);
              setModelId("");
              props.onClearNotice();
            }}
            value={providerId}
          >
            {providers.length === 0 ? <option value={providerId}>{selectedProvider}</option> : null}
            {providers.map((provider: ProviderChoice) => (
              <option key={provider.id} value={provider.id}>
                {provider.name} · {provider.modelCount} 个模型
              </option>
            ))}
          </select>
        </label>

        <label className="settings-field">
          <span>模型</span>
          <select
            onChange={(event) => {
              setModelId(event.target.value);
              props.onClearNotice();
            }}
            value={selectedModel}
          >
            {currentModels.length === 0 ? (
              <option value={selectedModel}>{selectedModel || "加载中…"}</option>
            ) : null}
            {currentModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.name === model.id ? model.id : `${model.name} · ${model.id}`}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="settings-field">
        <span>默认推理强度</span>
        <select
          disabled={thinkingLevels.length <= 1}
          onChange={(event) => setThinkingLevel(event.target.value)}
          value={effectiveThinkingLevel}
        >
          {thinkingLevels.map((level) => (
            <option key={level} value={level}>
              {thinkingLabel(level)}
            </option>
          ))}
        </select>
      </label>

      {modelsQuery.isError ? (
        <p className="settings-inline-error">无法读取该 Provider 的模型列表。</p>
      ) : null}

      <label className="settings-field">
        <span className="settings-field-label">
          <KeyRound size={14} />
          API Key
        </span>
        <input
          autoComplete="off"
          onChange={(event) => {
            setApiKey(event.target.value);
            props.onClearNotice();
          }}
          placeholder={
            settings.apiKeySource === "environment"
              ? "由环境变量提供，无需填写"
              : settings.apiKeyConfigured
                ? "已配置。留空则保持不变"
                : "粘贴 Provider API Key"
          }
          type="password"
          value={apiKey}
        />
        <small>
          {settings.apiKeySource === "environment"
            ? "当前 Key 来自环境变量；在这里填写会覆盖为设置页保存的值。"
            : settings.apiKeyConfigured
              ? "密钥已保存，界面不会再次显示。"
              : "接入模型前需要填写 Provider 的 API Key。"}
        </small>
      </label>

      <div className="settings-actions">
        <button
          className="btn btn-primary settings-save"
          disabled={!canSave || props.isSaving}
          onClick={() => save()}
          type="button"
        >
          {props.isSaving ? "保存中…" : "保存并应用"}
        </button>
        <button
          className="btn btn-ghost"
          disabled={testing || props.isSaving || selectedModel === ""}
          onClick={() => void testConnection()}
          type="button"
        >
          {testing ? "测试中…" : "测试连接"}
        </button>
        {settings.apiKeySource === "credentials" ? (
          <button
            className="btn btn-ghost"
            disabled={props.isSaving}
            onClick={() => save(true)}
            type="button"
          >
            清除已保存的 Key
          </button>
        ) : null}
      </div>

      {!canSave ? (
        <p className="settings-hint">填写 Provider 的 API Key 后才能保存并接入模型。</p>
      ) : null}
      {props.notice ? (
        <p className={`settings-notice${props.notice.kind === "error" ? " error" : " success"}`}>
          {props.notice.kind === "error" ? <CircleAlert size={14} /> : <Check size={14} />}
          {props.notice.text}
        </p>
      ) : null}
      {testNotice ? (
        <p className={`settings-notice${testNotice.kind === "error" ? " error" : " success"}`}>
          {testNotice.kind === "error" ? <CircleAlert size={14} /> : <Check size={14} />}
          {testNotice.text}
        </p>
      ) : null}
      <p className="settings-footnote">
        新建对话会使用新配置；已打开的对话及其子 Agent 保持原模型，避免中途错配上下文。
      </p>
    </div>
  );
}

function thinkingLabel(level: string): string {
  return (
    {
      high: "高",
      low: "低",
      max: "最大",
      medium: "中",
      minimal: "极低",
      off: "关闭",
      xhigh: "极高",
    }[level] ?? level
  );
}

function ApprovalOption(props: {
  active: boolean;
  description: string;
  label: string;
  onSelect: () => void;
}) {
  return (
    <label className={`approval-option${props.active ? " active" : ""}`}>
      <input
        checked={props.active}
        className="approval-native-radio"
        name="approval-mode"
        onChange={props.onSelect}
        type="radio"
      />
      <span className="approval-radio" aria-hidden="true">
        {props.active ? <span /> : null}
      </span>
      <span className="approval-copy">
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
    </label>
  );
}

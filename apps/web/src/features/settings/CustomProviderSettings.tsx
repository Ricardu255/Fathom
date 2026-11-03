import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { apiFetch } from "../../api/client";
import { customProvidersQueryOptions, queryKeys } from "../../api/queries";
import type {
  CustomProviderModel,
  CustomProviderProtocol,
  CustomProviderView,
} from "../../api/types";

const PROTOCOLS: Array<{ label: string; value: CustomProviderProtocol }> = [
  { label: "OpenAI Completions", value: "openai-completions" },
  { label: "OpenAI Responses", value: "openai-responses" },
  { label: "Anthropic Messages", value: "anthropic-messages" },
];

const EMPTY_MODEL: CustomProviderModel = {
  contextWindow: 128_000,
  id: "",
  maxTokens: 32_000,
  name: "",
  reasoning: true,
};

function createModelDraft(): ModelDraft {
  return {
    ...EMPTY_MODEL,
    key: globalThis.crypto?.randomUUID?.() ?? `model-${Date.now()}-${Math.random()}`,
  };
}

interface ModelDraft extends CustomProviderModel {
  key: string;
}

export function CustomProviderSettings() {
  const queryClient = useQueryClient();
  const providersQuery = useQuery(customProvidersQueryOptions());
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [protocol, setProtocol] = useState<CustomProviderProtocol>("openai-completions");
  const [apiKey, setApiKey] = useState("");
  const [requiresApiKey, setRequiresApiKey] = useState(true);
  const [models, setModels] = useState<ModelDraft[]>([createModelDraft()]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.customProviders }),
      queryClient.invalidateQueries({ queryKey: queryKeys.modelCatalog }),
      queryClient.invalidateQueries({ queryKey: queryKeys.settings }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<CustomProviderView>("/api/providers/custom", {
        body: JSON.stringify({
          ...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
          baseUrl,
          models: models.map(({ key: _key, ...model }) => model),
          name,
          protocol,
          requiresApiKey,
        }),
        method: "POST",
      }),
    onError: (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "创建自定义 Provider 失败");
    },
    onSuccess: async () => {
      setShowForm(false);
      setName("");
      setBaseUrl("");
      setApiKey("");
      setModels([createModelDraft()]);
      setError(null);
      await refresh();
    },
  });

  const removeMutation = useMutation({
    mutationFn: (providerId: string) =>
      apiFetch<void>(`/api/providers/custom/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
      }),
    onSuccess: refresh,
  });

  const updateModel = (index: number, patch: Partial<CustomProviderModel>) => {
    setModels((current) =>
      current.map((model, itemIndex) => (itemIndex === index ? { ...model, ...patch } : model)),
    );
  };

  return (
    <div className="custom-providers">
      <div className="custom-providers-head">
        <div>
          <strong>自定义 Provider</strong>
          <span>接入 OpenAI-compatible 或 Anthropic-compatible 端点。</span>
        </div>
        <button
          className="btn btn-ghost"
          onClick={() => setShowForm((value) => !value)}
          type="button"
        >
          {showForm ? <X size={14} /> : <Plus size={14} />}
          {showForm ? "取消" : "添加"}
        </button>
      </div>

      {providersQuery.data !== undefined && providersQuery.data.length > 0 ? (
        <div className="custom-provider-list">
          {providersQuery.data.map((provider) => (
            <div className="custom-provider-row" key={provider.id}>
              <div>
                <strong>{provider.name}</strong>
                <span>
                  {provider.protocol} · {provider.models.length} 个模型 ·{" "}
                  {provider.configured ? "已配置" : "未配置"}
                </span>
                <code>{provider.baseUrl}</code>
              </div>
              <button
                aria-label={`删除 ${provider.name}`}
                className="session-action"
                disabled={removeMutation.isPending}
                onClick={() => {
                  if (window.confirm(`删除自定义 Provider “${provider.name}”？`)) {
                    removeMutation.mutate(provider.id);
                  }
                }}
                type="button"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {showForm ? (
        <form
          className="custom-provider-form"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            createMutation.mutate();
          }}
        >
          <div className="settings-field-grid">
            <label className="settings-field">
              <span>名称</span>
              <input
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：本地 OpenAI 兼容服务"
                value={name}
              />
            </label>
            <label className="settings-field">
              <span>协议</span>
              <select
                onChange={(event) => setProtocol(event.target.value as CustomProviderProtocol)}
                value={protocol}
              >
                {PROTOCOLS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="settings-field">
            <span>Base URL</span>
            <input
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://api.example.com/v1"
              value={baseUrl}
            />
          </label>

          <label className="settings-field">
            <span>API Key</span>
            <input
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={requiresApiKey ? "必填" : "可选"}
              type="password"
              value={apiKey}
            />
          </label>

          <label className="custom-provider-check">
            <input
              checked={requiresApiKey}
              onChange={(event) => setRequiresApiKey(event.target.checked)}
              type="checkbox"
            />
            需要 API Key
          </label>

          <div className="custom-model-list">
            <div className="custom-model-title">
              <span>模型</span>
              <button
                className="btn btn-ghost"
                onClick={() => setModels((current) => [...current, createModelDraft()])}
                type="button"
              >
                <Plus size={13} /> 添加模型
              </button>
            </div>
            {models.map((model, index) => (
              <div className="custom-model-row" key={model.key}>
                <input
                  aria-label={`模型 ID ${index + 1}`}
                  onChange={(event) =>
                    updateModel(index, {
                      id: event.target.value,
                      name: model.name === "" ? event.target.value : model.name,
                    })
                  }
                  placeholder="model-id"
                  value={model.id}
                />
                <input
                  aria-label={`上下文窗口 ${index + 1}`}
                  min={1024}
                  onChange={(event) =>
                    updateModel(index, {
                      contextWindow: Number(event.target.value) || 128_000,
                    })
                  }
                  type="number"
                  value={model.contextWindow}
                />
                <input
                  aria-label={`最大输出 ${index + 1}`}
                  min={1}
                  onChange={(event) =>
                    updateModel(index, {
                      maxTokens: Number(event.target.value) || 32_000,
                    })
                  }
                  type="number"
                  value={model.maxTokens}
                />
                <label className="custom-model-reasoning">
                  <input
                    checked={model.reasoning}
                    onChange={(event) => updateModel(index, { reasoning: event.target.checked })}
                    type="checkbox"
                  />
                  推理
                </label>
                <button
                  aria-label={`删除模型 ${index + 1}`}
                  className="session-action"
                  disabled={models.length <= 1}
                  onClick={() =>
                    setModels((current) => current.filter((_, itemIndex) => itemIndex !== index))
                  }
                  type="button"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>

          {error !== null ? <p className="settings-inline-error">{error}</p> : null}

          <div className="settings-actions">
            <button className="btn btn-primary" disabled={createMutation.isPending} type="submit">
              {createMutation.isPending ? "创建中…" : "创建 Provider"}
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

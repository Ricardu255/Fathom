import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Cpu, Search } from "lucide-react";
import { useState } from "react";
import { modelCatalogQueryOptions } from "../api/queries";
import type { ThinkingLevel } from "../api/types";

export interface ModelSelection {
  modelId: string;
  providerId: string;
  thinkingLevel: ThinkingLevel;
}

export function ModelPicker(props: {
  disabled?: boolean;
  onChange: (selection: ModelSelection) => void;
  value: ModelSelection | null;
}) {
  const catalogQuery = useQuery(modelCatalogQueryOptions());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const catalog = catalogQuery.data;
  const provider =
    catalog?.providers.find((item) => item.id === props.value?.providerId) ??
    catalog?.providers.find((item) => item.id === catalog.default.providerId) ??
    catalog?.providers[0];
  const model =
    provider?.models.find((item) => item.id === props.value?.modelId) ??
    provider?.models.find((item) => item.id === catalog?.default.modelId) ??
    provider?.models[0];
  const thinkingLevel = clampThinking(
    (props.value?.thinkingLevel ?? catalog?.default.thinkingLevel ?? "medium") as ThinkingLevel,
    model?.thinkingLevels ?? ["off"],
  );
  const needle = query.trim().toLocaleLowerCase();
  const searchResults =
    needle === "" || catalog === undefined
      ? []
      : catalog.providers
          .flatMap((item) =>
            item.models
              .filter(
                (candidate) =>
                  candidate.name.toLocaleLowerCase().includes(needle) ||
                  candidate.id.toLocaleLowerCase().includes(needle) ||
                  item.name.toLocaleLowerCase().includes(needle),
              )
              .map((candidate) => ({ model: candidate, provider: item })),
          )
          .slice(0, 30);

  const selectProvider = (providerId: string) => {
    const nextProvider = catalog?.providers.find((item) => item.id === providerId);
    const nextModel = nextProvider?.models[0];
    if (nextProvider === undefined || nextModel === undefined) return;
    props.onChange({
      modelId: nextModel.id,
      providerId: nextProvider.id,
      thinkingLevel: clampThinking(thinkingLevel, nextModel.thinkingLevels),
    });
  };

  const toggleOpen = () => {
    if (open) setQuery("");
    setOpen((value) => !value);
  };

  const close = () => {
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="model-picker">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="model-picker-trigger"
        disabled={props.disabled === true || catalogQuery.isPending}
        onClick={toggleOpen}
        type="button"
      >
        <Cpu size={11} />
        <span className="model-picker-label">
          {model?.name ?? (catalogQuery.isError ? "模型目录加载失败" : "加载模型…")}
        </span>
        {thinkingLevel !== "off" ? (
          <span className="model-picker-thinking">{thinkingLabel(thinkingLevel)}</span>
        ) : null}
        <ChevronDown size={10} />
      </button>

      {open && catalog !== undefined ? (
        <>
          <button
            aria-label="关闭模型选择"
            className="model-picker-backdrop"
            onClick={close}
            type="button"
          />
          <div aria-label="选择模型" className="model-picker-panel" role="dialog">
            <div className="model-picker-head">
              <strong>模型与推理</strong>
              <span>{provider?.name ?? "未选择 Provider"}</span>
            </div>
            <label className="model-picker-search">
              <Search size={10} />
              <input
                aria-label="搜索模型"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索模型或 Provider"
                value={query}
              />
            </label>
            {needle !== "" ? (
              <div className="model-picker-results">
                {searchResults.length === 0 ? (
                  <div className="model-picker-empty">没有匹配模型</div>
                ) : (
                  searchResults.map((result) => (
                    <button
                      key={`${result.provider.id}:${result.model.id}`}
                      onClick={() => {
                        props.onChange({
                          modelId: result.model.id,
                          providerId: result.provider.id,
                          thinkingLevel: clampThinking(thinkingLevel, result.model.thinkingLevels),
                        });
                        setQuery("");
                        setOpen(false);
                      }}
                      type="button"
                    >
                      <span>
                        <strong>{result.model.name}</strong>
                        <small>
                          {result.provider.name} · {formatContext(result.model.contextWindow)}
                          {result.provider.configured ? "" : " · 未配置 Key"}
                        </small>
                      </span>
                      {result.provider.id === provider?.id && result.model.id === model?.id ? (
                        <Check size={10} />
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            ) : null}
            <label className="model-picker-field">
              <span>Provider</span>
              <select
                onChange={(event) => selectProvider(event.target.value)}
                value={provider?.id ?? ""}
              >
                {catalog.providers.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                    {item.configured ? "" : "（未配置 Key）"}
                  </option>
                ))}
              </select>
            </label>
            <label className="model-picker-field">
              <span>模型</span>
              <select
                onChange={(event) => {
                  const modelId = event.target.value;
                  const nextModel = provider?.models.find((item) => item.id === modelId);
                  if (provider === undefined || nextModel === undefined) return;
                  props.onChange({
                    modelId,
                    providerId: provider.id,
                    thinkingLevel: clampThinking(thinkingLevel, nextModel.thinkingLevels),
                  });
                }}
                value={model?.id ?? ""}
              >
                {provider?.models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {formatContext(item.contextWindow)}
                  </option>
                ))}
              </select>
            </label>
            <label className="model-picker-field">
              <span>推理强度</span>
              <select
                disabled={(model?.thinkingLevels.length ?? 1) <= 1}
                onChange={(event) => {
                  if (provider === undefined || model === undefined) return;
                  props.onChange({
                    modelId: model.id,
                    providerId: provider.id,
                    thinkingLevel: event.target.value as ThinkingLevel,
                  });
                }}
                value={thinkingLevel}
              >
                {model?.thinkingLevels.map((level) => (
                  <option key={level} value={level}>
                    {thinkingLabel(level as ThinkingLevel)}
                  </option>
                ))}
              </select>
            </label>
            <div className="model-picker-foot">
              {model === undefined || model.contextWindow === undefined ? null : (
                <span>
                  上下文 {formatContext(model.contextWindow)} · 输出{" "}
                  {formatContext(model.maxTokens)}
                </span>
              )}
              <button className="btn btn-ghost" onClick={close} type="button">
                <Check size={10} /> 完成
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function clampThinking(level: ThinkingLevel, available: readonly string[]): ThinkingLevel {
  if (available.includes(level)) return level;
  if (available.includes("medium")) return "medium";
  const first = available[0];
  return (first ?? "off") as ThinkingLevel;
}

function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
  return `${Math.round(tokens / 1000)}k`;
}

function thinkingLabel(level: ThinkingLevel): string {
  switch (level) {
    case "off":
      return "关闭";
    case "minimal":
      return "极低";
    case "low":
      return "低";
    case "medium":
      return "中";
    case "high":
      return "高";
    case "xhigh":
      return "极高";
    case "max":
      return "最大";
  }
}

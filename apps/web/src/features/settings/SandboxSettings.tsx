import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, apiFetch } from "../../api/client";
import { queryKeys } from "../../api/queries";
import type { HarnessSettings, SandboxSettings as SandboxSettingsValue } from "../../api/types";

const PROFILE_OPTIONS: Array<{
  description: string;
  label: string;
  value: SandboxSettingsValue["profile"];
}> = [
  {
    description: "不启用额外限制，仍保留路径、审批与 SSRF 防护。",
    label: "关闭",
    value: "off",
  },
  {
    description: "只允许读取、检索与联网；拒绝写文件、执行命令、子 Agent 和记忆写入。",
    label: "只读",
    value: "read_only",
  },
  {
    description: "允许写 workspace 与执行命令；网络仍受域名白名单/黑名单约束。",
    label: "workspace 写入",
    value: "workspace_write",
  },
];

export function SandboxSettings({ settings }: { settings: HarnessSettings }) {
  const queryClient = useQueryClient();
  const [profile, setProfile] = useState<SandboxSettingsValue["profile"]>(
    settings.sandbox?.profile ?? "off",
  );
  const [allowedDomains, setAllowedDomains] = useState(
    (settings.sandbox?.allowedDomains ?? []).join("\n"),
  );
  const [deniedDomains, setDeniedDomains] = useState(
    (settings.sandbox?.deniedDomains ?? []).join("\n"),
  );
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const mutation = useMutation({
    mutationFn: () =>
      apiFetch<HarnessSettings>("/api/settings/sandbox", {
        body: JSON.stringify({
          allowedDomains: splitDomains(allowedDomains),
          deniedDomains: splitDomains(deniedDomains),
          profile,
        }),
        method: "PUT",
      }),
    onError: (error: unknown) => {
      setNotice({
        kind: "error",
        text: error instanceof ApiError ? error.message : "保存沙箱设置失败",
      });
    },
    onSuccess: async (next) => {
      setNotice({ kind: "success", text: "沙箱设置已保存，工具调用立即生效。" });
      queryClient.setQueryData(queryKeys.settings, next);
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });

  return (
    <div className="sandbox-settings">
      <div className="sandbox-profile-options">
        {PROFILE_OPTIONS.map((option) => (
          <label
            className={`sandbox-profile${profile === option.value ? " active" : ""}`}
            key={option.value}
          >
            <input
              checked={profile === option.value}
              name="sandbox-profile"
              onChange={() => {
                setProfile(option.value);
                setNotice(null);
              }}
              type="radio"
              value={option.value}
            />
            <span>
              <strong>{option.label}</strong>
              <small>{option.description}</small>
            </span>
          </label>
        ))}
      </div>
      <div className="sandbox-domain-grid">
        <label>
          域名白名单（每行一个，留空表示不限制）
          <textarea
            onChange={(event) => setAllowedDomains(event.target.value)}
            placeholder="example.com&#10;*.trusted.dev"
            rows={4}
            value={allowedDomains}
          />
        </label>
        <label>
          域名黑名单（优先于白名单）
          <textarea
            onChange={(event) => setDeniedDomains(event.target.value)}
            placeholder="blocked.example.com"
            rows={4}
            value={deniedDomains}
          />
        </label>
      </div>
      {notice !== null ? (
        <div className={notice.kind === "error" ? "inline-error" : "settings-inline-success"}>
          {notice.text}
        </div>
      ) : null}
      <button
        className="btn btn-primary"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
        type="button"
      >
        {mutation.isPending ? "保存中…" : "保存沙箱设置"}
      </button>
      <p className="muted-text">
        沙箱设置保存在本机；网络边界作用于 web_fetch / web_search。凭据注入尚未接入。
      </p>
    </div>
  );
}

function splitDomains(value: string): string[] {
  return value
    .split(/\r?\n|,/u)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

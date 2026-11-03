import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Download, Loader2, Sparkles } from "lucide-react";
import { useState } from "react";
import { ApiError, apiFetch } from "../../api/client";
import {
  queryKeys,
  skillDetailQueryOptions,
  skillsQueryOptions,
  workspacesQueryOptions,
} from "../../api/queries";
import type { SkillSummary } from "../../api/types";

const SCOPE_LABELS: Record<SkillSummary["scope"], string> = {
  global: "全局",
  project: "项目",
  system: "系统",
};

export function SkillSettings() {
  const queryClient = useQueryClient();
  const [workspaceId, setWorkspaceId] = useState("");
  const [repo, setRepo] = useState("");
  const [subdir, setSubdir] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  const workspacesQuery = useQuery(workspacesQueryOptions());
  const skillsQuery = useQuery(skillsQueryOptions(workspaceId === "" ? undefined : workspaceId));
  const skills = skillsQuery.data ?? [];

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.skills(workspaceId || undefined) });
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
  };

  const toggleMutation = useMutation({
    mutationFn: (skill: SkillSummary) =>
      apiFetch<{ disabled: string[] }>(
        `/api/settings/skills/${encodeURIComponent(skill.scope)}/${encodeURIComponent(skill.id)}`,
        {
          body: JSON.stringify({ enabled: !skill.enabled }),
          method: "PUT",
        },
      ),
    onError: (error: unknown) => {
      setNotice({
        kind: "error",
        text: error instanceof ApiError ? error.message : "切换 Skill 失败",
      });
    },
    onSuccess: async () => {
      setNotice(null);
      await invalidate();
    },
  });

  const installMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ name: string }>("/api/skills/install", {
        body: JSON.stringify({
          repo,
          ...(subdir.trim() === "" ? {} : { subdir: subdir.trim() }),
        }),
        method: "POST",
      }),
    onError: (error: unknown) => {
      setNotice({
        kind: "error",
        text: error instanceof ApiError ? error.message : "安装 Skill 失败",
      });
    },
    onSuccess: async (result) => {
      setRepo("");
      setSubdir("");
      setNotice({ kind: "success", text: `已安装 Skill「${result.name}」到全局目录。` });
      await invalidate();
    },
  });

  return (
    <div className="skill-settings">
      <div className="skill-toolbar">
        <label>
          项目工作区
          <select onChange={(event) => setWorkspaceId(event.target.value)} value={workspaceId}>
            <option value="">仅系统 / 全局</option>
            {(workspacesQuery.data ?? [])
              .filter((workspace) => workspace.removedAt === null)
              .map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.displayName}
                </option>
              ))}
          </select>
        </label>
      </div>

      {skillsQuery.isPending ? (
        <p className="muted-text">读取 Skills…</p>
      ) : skills.length === 0 ? (
        <p className="muted-text">
          没有发现 Skill。可从 GitHub 安装或让 Agent 用 skill_creator 创建项目 Skill。
        </p>
      ) : (
        <div className="skill-list">
          {skills.map((skill) => {
            const key = `${skill.scope}:${skill.id}`;
            return (
              <div className="skill-row" key={key}>
                <div className="skill-row-head">
                  <Sparkles size={13} />
                  <div className="skill-row-title">
                    <strong>{skill.id}</strong>
                    <span>
                      {SCOPE_LABELS[skill.scope]} · {skill.description}
                    </span>
                  </div>
                  <label className="skill-toggle">
                    <input
                      checked={skill.enabled}
                      disabled={toggleMutation.isPending}
                      onChange={() => toggleMutation.mutate(skill)}
                      type="checkbox"
                    />
                    启用
                  </label>
                  <button
                    aria-label={openKey === key ? "收起正文" : "查看正文"}
                    className="skill-detail-toggle"
                    onClick={() => setOpenKey(openKey === key ? null : key)}
                    type="button"
                  >
                    <ChevronDown className={openKey === key ? "open" : ""} size={13} />
                  </button>
                </div>
                {openKey === key ? (
                  <SkillDetailPanel
                    id={skill.id}
                    scope={skill.scope}
                    workspaceId={workspaceId === "" ? undefined : workspaceId}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="skill-install">
        <div className="skill-install-head">
          <Download size={13} />
          <strong>从 GitHub 安装</strong>
        </div>
        <div className="skill-install-fields">
          <input
            onChange={(event) => setRepo(event.target.value)}
            placeholder="owner/repo"
            value={repo}
          />
          <input
            onChange={(event) => setSubdir(event.target.value)}
            placeholder="子目录（可选）"
            value={subdir}
          />
          <button
            className="btn btn-primary"
            disabled={repo.trim() === "" || installMutation.isPending}
            onClick={() => installMutation.mutate()}
            type="button"
          >
            {installMutation.isPending ? <Loader2 className="spin" size={12} /> : null}
            安装
          </button>
        </div>
        <p className="muted-text">
          仅接受 owner/repo；仓库必须包含 SKILL.md。安装会写入全局 Skill 目录，已存在同名 Skill
          时拒绝覆盖。
        </p>
      </div>

      {notice !== null ? (
        <div className={notice.kind === "error" ? "inline-error" : "settings-inline-success"}>
          {notice.text}
        </div>
      ) : null}
    </div>
  );
}

function SkillDetailPanel({
  id,
  scope,
  workspaceId,
}: {
  id: string;
  scope: SkillSummary["scope"];
  workspaceId?: string | undefined;
}) {
  const detailQuery = useQuery(skillDetailQueryOptions(scope, id, workspaceId));
  if (detailQuery.isPending) return <p className="muted-text">读取正文…</p>;
  if (detailQuery.error !== null)
    return <div className="inline-error">{detailQuery.error.message}</div>;
  const detail = detailQuery.data;
  if (detail === undefined) return null;
  return (
    <div className="skill-detail">
      {detail.resources.length > 0 ? (
        <p className="muted-text">
          资源：{detail.resources.map((resource) => resource.path).join("、")}
        </p>
      ) : null}
      <pre>{detail.body.slice(0, 20_000)}</pre>
    </div>
  );
}

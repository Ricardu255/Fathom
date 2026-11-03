import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../../api/client";
import { queryKeys } from "../../api/queries";
import type { Workspace } from "../../api/types";

export async function chooseWorkspaceDirectory(): Promise<string | null> {
  if (window.fathom?.workspace?.chooseDirectory !== undefined) {
    return window.fathom.workspace.chooseDirectory();
  }
  const entered = window.prompt("输入工作区目录的绝对路径");
  const trimmed = entered?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

export function useAddWorkspace(): () => Promise<Workspace | null> {
  const queryClient = useQueryClient();
  return async () => {
    const path = await chooseWorkspaceDirectory();
    if (path === null) return null;
    const workspace = await apiFetch<Workspace>("/api/workspaces", {
      body: JSON.stringify({ path }),
      method: "POST",
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.workspaces });
    return workspace;
  };
}

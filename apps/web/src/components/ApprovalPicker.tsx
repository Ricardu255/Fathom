import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { apiFetch } from "../api/client";
import { queryKeys, settingsQueryOptions } from "../api/queries";
import type { HarnessSettings } from "../api/types";

const MODES: Array<{ label: string; value: HarnessSettings["approvalMode"] }> = [
  { label: "逐次", value: "request_approval" },
  { label: "自动", value: "auto_approve" },
  { label: "完全", value: "full_access" },
];

export function ApprovalPicker({ disabled }: { disabled?: boolean }) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(settingsQueryOptions());
  const mutation = useMutation({
    mutationFn: (approvalMode: HarnessSettings["approvalMode"]) =>
      apiFetch<HarnessSettings>("/api/settings", {
        body: JSON.stringify({ approvalMode }),
        method: "PUT",
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.settings });
    },
  });

  return (
    <label className="approval-picker">
      <ShieldCheck size={10} />
      <span className="sr-only">审批模式</span>
      <select
        aria-label="审批模式"
        disabled={disabled === true || settingsQuery.isPending || mutation.isPending}
        onChange={(event) => mutation.mutate(event.target.value as HarnessSettings["approvalMode"])}
        value={settingsQuery.data?.approvalMode ?? "request_approval"}
      >
        {MODES.map((mode) => (
          <option key={mode.value} value={mode.value}>
            {mode.label}
          </option>
        ))}
      </select>
    </label>
  );
}

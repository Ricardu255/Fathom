import { type HarnessEvent, HarnessEventType } from "@harness/core";
import { merge } from "node-diff3";
import { compareSessionEvents } from "./session-compare";
import type { WorkspaceService } from "./workspace-service";

export interface FileMergePreview {
  base: string | null;
  conflict: boolean;
  merged: string | null;
  ours: string | null;
  path: string;
  theirs: string | null;
}

interface FileVersion {
  after: string | null;
  timestamp: number;
}

/** 基于事件中的 before/after 快照，对两个分支做逐文件三方合并。 */
export function previewCodeMerge(
  oursEvents: readonly HarnessEvent[],
  theirsEvents: readonly HarnessEvent[],
): FileMergePreview[] {
  const cutoff = compareSessionEvents(theirsEvents, oursEvents).commonCutoff;
  const paths = new Set<string>();
  for (const event of [...oursEvents, ...theirsEvents]) {
    if (event.type === HarnessEventType.FILE_CHANGED) {
      const path = readPath(event);
      if (path !== null) paths.add(path);
    }
  }

  return [...paths]
    .map((path) => {
      const base = fileAtOrBefore(oursEvents, path, cutoff);
      const oursVersion = latestFile(oursEvents, path);
      const theirsVersion = latestFile(theirsEvents, path);
      const ours = oursVersion.found ? oursVersion.value : base;
      const theirs = theirsVersion.found ? theirsVersion.value : base;
      return mergeFile(path, base, ours, theirs);
    })
    .filter((file) => file.ours !== file.theirs);
}

export async function applyCodeMerge(
  files: readonly FileMergePreview[],
  workspace: WorkspaceService,
  workspaceRoot: string,
): Promise<void> {
  if (files.some((file) => file.conflict)) {
    throw new Error("存在冲突，不能自动应用代码合并");
  }
  for (const file of files) {
    if (file.merged === null) {
      await workspace.delete(workspaceRoot, file.path);
    } else {
      await workspace.write(workspaceRoot, file.path, file.merged);
    }
  }
}

function mergeFile(
  path: string,
  base: string | null,
  ours: string | null,
  theirs: string | null,
): FileMergePreview {
  if (ours === theirs) {
    return { base, conflict: false, merged: ours, ours, path, theirs };
  }
  if (ours === base) {
    return { base, conflict: false, merged: theirs, ours, path, theirs };
  }
  if (theirs === base) {
    return { base, conflict: false, merged: ours, ours, path, theirs };
  }
  if (base === null || ours === null || theirs === null) {
    return { base, conflict: true, merged: ours ?? theirs, ours, path, theirs };
  }

  const result = merge(ours.split("\n"), base.split("\n"), theirs.split("\n"), {
    excludeFalseConflicts: true,
  });
  return {
    base,
    conflict: result.conflict,
    merged: result.result.join("\n"),
    ours,
    path,
    theirs,
  };
}

function latestFile(
  events: readonly HarnessEvent[],
  path: string,
): { found: boolean; value: string | null } {
  const versions = versionsOf(events, path);
  const last = versions.at(-1);
  return last === undefined ? { found: false, value: null } : { found: true, value: last.after };
}

function fileAtOrBefore(
  events: readonly HarnessEvent[],
  path: string,
  cutoff: number,
): string | null {
  const versions = versionsOf(events, path);
  const beforeCutoff = versions.filter((version) => version.timestamp <= cutoff);
  if (beforeCutoff.length > 0) return beforeCutoff.at(-1)?.after ?? null;
  const first = versions[0];
  if (first === undefined) return null;
  const event = events.find(
    (candidate) => candidate.type === HarnessEventType.FILE_CHANGED && readPath(candidate) === path,
  );
  return event === undefined ? null : readBefore(event);
}

function versionsOf(events: readonly HarnessEvent[], path: string): FileVersion[] {
  return events
    .filter((event) => event.type === HarnessEventType.FILE_CHANGED && readPath(event) === path)
    .map((event) => ({ after: readAfter(event), timestamp: event.timestamp }));
}

function readPath(event: HarnessEvent): string | null {
  if (event.type !== HarnessEventType.FILE_CHANGED) return null;
  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const path = (data as { path?: unknown }).path;
  return typeof path === "string" && path !== "" ? path : null;
}

function readAfter(event: HarnessEvent): string | null {
  const value = (event.data as { after?: unknown }).after;
  return typeof value === "string" ? value : null;
}

function readBefore(event: HarnessEvent): string | null {
  const value = (event.data as { before?: unknown }).before;
  return typeof value === "string" ? value : null;
}

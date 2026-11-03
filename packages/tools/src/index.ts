import type { Tool } from "@harness/core";
import { createRunCommandTool } from "./command-tool";
import {
  editFileTool,
  listFilesTool,
  readFileTool,
  searchTextTool,
  writeFileTool,
} from "./file-tools";
import { searchKnowledgeTool } from "./search-knowledge";
import { updateTodosTool } from "./todos-tool";
import { createViewImageTool } from "./view-image";
import { createWebFetchTool } from "./web-fetch";
import { createWebSearchTool } from "./web-search";

export {
  createRunCommandTool,
  runCommandTool,
  type SandboxCommandRunner,
  type SandboxedCommandOutput,
} from "./command-tool";
export {
  editFileTool,
  listFilesTool,
  listWorkspaceEntries,
  readFileTool,
  searchTextTool,
  type WorkspaceEntry,
  writeFileTool,
} from "./file-tools";
export { searchKnowledgeTool } from "./search-knowledge";
export { updateTodosTool } from "./todos-tool";
export { createViewImageTool, detectImage, type ViewImageOptions } from "./view-image";
export {
  assertPublicHttpUrl,
  createWebFetchTool,
  isPrivateAddress,
  type WebFetchOptions,
} from "./web-fetch";
export { createWebSearchTool, type WebSearchOptions } from "./web-search";

export interface WorkspaceToolOptions {
  commandRunner?: import("./command-tool").SandboxCommandRunner | undefined;
  networkCheck?: ((hostname: string) => string | undefined) | undefined;
  searxngUrl?: string | undefined;
  supportsImages?: (() => boolean) | undefined;
}

/** M1/M2 的 workspace 工具集；后续 memory/skill/sub-agent 工具在同一注册表上扩展。 */
export function createWorkspaceTools(options: WorkspaceToolOptions = {}): Tool[] {
  return [
    listFilesTool,
    readFileTool,
    searchTextTool,
    writeFileTool,
    editFileTool,
    createRunCommandTool(options.commandRunner),
    updateTodosTool,
    searchKnowledgeTool,
    createWebFetchTool(
      options.networkCheck === undefined ? {} : { networkCheck: options.networkCheck },
    ),
    createWebSearchTool({
      ...(options.networkCheck === undefined ? {} : { networkCheck: options.networkCheck }),
      searxngUrl: options.searxngUrl,
    }),
    createViewImageTool({ supportsImages: options.supportsImages ?? (() => false) }),
  ];
}

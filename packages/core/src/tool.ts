import type { FileChange, TodoItem } from "./events";
import type { KnowledgeSearch } from "./knowledge";
import type { MessageImage } from "./messages";
import type { ToolDefinition } from "./provider";

export interface ToolContext {
  protectedPaths?: readonly string[];
  searchKnowledge?: KnowledgeSearch;
  signal: AbortSignal;
  workspaceRoot: string;
}

export interface FileObservation {
  /** realpath 后的绝对路径，用于跨 Agent 的写锁与 observed-content 校验。 */
  path: string;
  /** 文件内容的 sha256。 */
  hash: string;
}

export interface ToolResult {
  content: string;
  fileChanges?: readonly FileChange[];
  /** 本次工具观察到的文件内容指纹；写工具写入后也应记录新指纹。 */
  observedFiles?: readonly FileObservation[];
  /** 图片结果会作为 image content 发给支持视觉的模型。 */
  images?: readonly MessageImage[];
  isError?: boolean;
  todos?: readonly TodoItem[];
}

export interface Tool {
  description: string;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
  inputSchema: Record<string, unknown>;
  name: string;
  /** 解析并校验模型给出的参数；抛错会被转换为工具失败结果。 */
  parse(input: unknown): unknown;
  requiresApproval: boolean;
  summarize(input: unknown): string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  public register(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error(`工具名称重复: ${tool.name}`);
    this.tools.set(tool.name, tool);
    return this;
  }

  public get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public names(): readonly string[] {
    return [...this.tools.keys()];
  }

  public definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      description: tool.description,
      inputSchema: tool.inputSchema,
      name: tool.name,
    }));
  }
}

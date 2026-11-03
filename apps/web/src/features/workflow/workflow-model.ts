export type WorkflowAgentType = "explorer" | "reviewer" | "worker";

export interface WorkflowNodeDraft {
  agentType: WorkflowAgentType;
  dependsOn: string[];
  id: string;
  task: string;
  title: string;
}

const NODE_LIMIT = 12;
const DEPENDENCY_LIMIT = 8;

export function createWorkflowNode(index: number): WorkflowNodeDraft {
  return {
    agentType: "worker",
    dependsOn: [],
    id: `node-${index}`,
    task: "",
    title: `节点 ${index}`,
  };
}

export function createWorkflowTemplate(): WorkflowNodeDraft[] {
  return [
    {
      agentType: "explorer",
      dependsOn: [],
      id: "research",
      task: "调研工作区结构、相关实现与约束，输出关键文件和改进建议。",
      title: "调研工作区",
    },
    {
      agentType: "worker",
      dependsOn: ["research"],
      id: "implement",
      task: "根据调研结果实现改进，并验证核心路径。",
      title: "实现改进",
    },
    {
      agentType: "worker",
      dependsOn: ["research"],
      id: "docs",
      task: "整理实现说明、使用方式和注意事项。",
      title: "整理文档",
    },
    {
      agentType: "reviewer",
      dependsOn: ["implement", "docs"],
      id: "review",
      task: "审查实现与文档，指出风险、遗漏和可验证的问题。",
      title: "审查结果",
    },
  ];
}

export function validateWorkflow(nodes: readonly WorkflowNodeDraft[]): string[] {
  const errors: string[] = [];
  if (nodes.length === 0) errors.push("至少需要一个节点");
  if (nodes.length > NODE_LIMIT) errors.push(`最多 ${NODE_LIMIT} 个节点`);

  const ids = new Set<string>();
  for (const node of nodes) {
    const id = node.id.trim();
    if (id === "") errors.push("节点 id 不能为空");
    if (ids.has(id)) errors.push(`节点 id 重复：${id}`);
    ids.add(id);
    if (node.task.trim() === "") errors.push(`节点 ${node.title || id} 缺少任务描述`);
    if (node.dependsOn.length > DEPENDENCY_LIMIT) {
      errors.push(`节点 ${node.title || id} 依赖不能超过 ${DEPENDENCY_LIMIT} 个`);
    }
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!byId.has(dependency)) {
        errors.push(`节点 ${node.title || node.id} 依赖不存在的节点：${dependency}`);
      }
      if (dependency === node.id) {
        errors.push(`节点 ${node.title || node.id} 不能依赖自己`);
      }
    }
  }

  if (errors.length === 0 && hasCycle(nodes)) errors.push("工作流依赖存在环");
  return errors;
}

function hasCycle(nodes: readonly WorkflowNodeDraft[]): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    const node = byId.get(id);
    if (node !== undefined) {
      for (const dependency of node.dependsOn) {
        if (byId.has(dependency) && visit(dependency)) return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };

  return nodes.some((node) => visit(node.id));
}

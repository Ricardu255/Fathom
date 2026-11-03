import type { Session } from "../../api/types";

export interface SessionTreeNode {
  children: SessionTreeNode[];
  session: Session;
}

/** 将扁平的 parentSessionId 列表还原成森林；缺失父节点或成环时按根节点处理。 */
export function buildSessionTree(sessions: readonly Session[]): SessionTreeNode[] {
  const nodes = new Map<string, SessionTreeNode>(
    sessions.map((session) => [session.id, { children: [], session }]),
  );
  const roots: SessionTreeNode[] = [];
  const byId = new Map(sessions.map((session) => [session.id, session]));

  for (const node of nodes.values()) {
    const parentId = node.session.parentSessionId;
    const parent = parentId === null ? undefined : nodes.get(parentId);
    if (
      parent === undefined ||
      parent.session.id === node.session.id ||
      hasCycle(node.session, byId)
    ) {
      roots.push(node);
    } else {
      parent.children.push(node);
    }
  }

  const sort = (items: SessionTreeNode[]): void => {
    items.sort((left, right) => right.session.updatedAt - left.session.updatedAt);
    for (const item of items) sort(item.children);
  };
  sort(roots);
  return roots;
}

function hasCycle(session: Session, sessions: ReadonlyMap<string, Session>): boolean {
  const seen = new Set<string>([session.id]);
  let parentId = session.parentSessionId;
  while (parentId !== null) {
    if (seen.has(parentId)) return true;
    seen.add(parentId);
    parentId = sessions.get(parentId)?.parentSessionId ?? null;
  }
  return false;
}

export function countBranchNodes(nodes: readonly SessionTreeNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countBranchNodes(node.children), 0);
}

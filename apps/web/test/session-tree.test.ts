import assert from "node:assert/strict";
import { test } from "node:test";
import type { Session } from "../src/api/types";
import { buildSessionTree, countBranchNodes } from "../src/features/chat/session-tree";

function session(id: string, parentSessionId: string | null, updatedAt: number): Session {
  return {
    archivedAt: null,
    createdAt: updatedAt - 10,
    id,
    lastSeq: 0,
    modelId: "claude-sonnet-5-5",
    parentSessionId,
    providerId: "anthropic",
    thinkingLevel: "medium",
    title: id,
    updatedAt,
    workspaceId: "workspace-1",
    workspaceRoot: "/tmp/workspace",
  };
}

test("buildSessionTree 还原父子层级并按更新时间排序", () => {
  const tree = buildSessionTree([
    session("root", null, 10),
    session("child-late", "root", 30),
    session("child-early", "root", 20),
    session("grandchild", "child-late", 40),
  ]);

  assert.equal(tree.length, 1);
  assert.equal(tree[0]?.session.id, "root");
  assert.deepEqual(
    tree[0]?.children.map((node) => node.session.id),
    ["child-late", "child-early"],
  );
  assert.equal(tree[0]?.children[0]?.children[0]?.session.id, "grandchild");
  assert.equal(countBranchNodes(tree), 4);
});

test("缺失父节点与成环会话都作为根节点", () => {
  const orphan = buildSessionTree([session("orphan", "missing", 10)]);
  assert.deepEqual(
    orphan.map((node) => node.session.id),
    ["orphan"],
  );

  const cyclic = buildSessionTree([session("a", "b", 20), session("b", "a", 10)]);
  assert.equal(cyclic.length, 2);
  assert.deepEqual(new Set(cyclic.map((node) => node.session.id)), new Set(["a", "b"]));
});

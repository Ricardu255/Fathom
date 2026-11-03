import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { WorkspaceRegistryService } from "../services/workspace-registry-service";

const addWorkspaceSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  path: z.string().min(1).max(4_096),
});
const renameWorkspaceSchema = z.object({ displayName: z.string().min(1).max(120) });
const reorderWorkspaceSchema = z.object({ ids: z.array(z.string().min(1).max(64)).max(200) });

export async function registerWorkspaceRegistryRoutes(
  server: FastifyInstance,
  workspaces: WorkspaceRegistryService,
): Promise<void> {
  server.get<{ Querystring: { includeRemoved?: string } }>("/api/workspaces", async (request) =>
    workspaces.list(request.query.includeRemoved === "1"),
  );

  server.post("/api/workspaces", async (request, reply) => {
    const body = addWorkspaceSchema.parse(request.body);
    const workspace = await workspaces.add(body.path, body.displayName);
    return reply.status(201).send(workspace);
  });

  server.put("/api/workspaces/order", async (request) => {
    const body = reorderWorkspaceSchema.parse(request.body);
    return workspaces.reorder(body.ids);
  });

  server.patch<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId",
    async (request) => {
      const body = renameWorkspaceSchema.parse(request.body);
      return workspaces.rename(request.params.workspaceId, body.displayName);
    },
  );

  server.delete<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId",
    async (request, reply) => {
      workspaces.remove(request.params.workspaceId);
      return reply.status(204).send();
    },
  );
}

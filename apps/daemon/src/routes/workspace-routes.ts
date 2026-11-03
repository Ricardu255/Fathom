import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { SessionController } from "../services/session-types";
import type { WorkspaceService } from "../services/workspace-service";

const writeSchema = z.object({
  content: z.string().max(1_048_576),
  path: z.string().min(1).max(4_096),
});

export async function registerWorkspaceRoutes(
  server: FastifyInstance,
  workspace: WorkspaceService,
  sessions: SessionController,
): Promise<void> {
  server.get<{ Params: { sessionId: string }; Querystring: { path?: string } }>(
    "/api/sessions/:sessionId/file",
    async (request, reply) => {
      const session = sessions.getSession(request.params.sessionId);
      const path = request.query.path?.trim() ?? "";
      if (path === "") {
        return reply.status(400).send({ code: "INVALID_INPUT", message: "path 不能为空" });
      }
      return workspace.read(session.workspaceRoot, path);
    },
  );

  server.put<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/file",
    async (request) => {
      const session = sessions.getSession(request.params.sessionId);
      const body = writeSchema.parse(request.body);
      return workspace.write(session.workspaceRoot, body.path, body.content);
    },
  );
}

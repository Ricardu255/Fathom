import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BackgroundCommandService } from "../services/background-command-service";
import type { SessionController } from "../services/session-types";

const startSchema = z.object({
  command: z.string().min(1).max(65_536),
  name: z.string().min(1).max(80).optional(),
});

export async function registerBackgroundCommandRoutes(
  server: FastifyInstance,
  commands: BackgroundCommandService,
  sessions: SessionController,
): Promise<void> {
  server.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/background-commands",
    async (request) => {
      sessions.getSession(request.params.sessionId);
      return commands.list(request.params.sessionId);
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/background-commands",
    async (request, reply) => {
      const session = sessions.getSession(request.params.sessionId);
      const body = startSchema.parse(request.body);
      const command = commands.start({
        ...body,
        sessionId: session.id,
        workspaceRoot: session.workspaceRoot,
      });
      return reply.status(201).send(command);
    },
  );

  server.get<{ Params: { commandId: string; sessionId: string } }>(
    "/api/sessions/:sessionId/background-commands/:commandId",
    async (request) => commands.get(request.params.sessionId, request.params.commandId),
  );

  server.post<{ Params: { commandId: string; sessionId: string } }>(
    "/api/sessions/:sessionId/background-commands/:commandId/stop",
    async (request) => commands.stop(request.params.sessionId, request.params.commandId),
  );
}

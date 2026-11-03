import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { BoardTaskService } from "../services/board-task-service";

const createSchema = z.object({
  objective: z.string().min(1).max(20_000),
  title: z.string().min(1).max(120),
  workspaceRoot: z.string().min(1).max(4_096).optional(),
});

const updateSchema = z.object({
  objective: z.string().min(1).max(20_000).optional(),
  title: z.string().min(1).max(120).optional(),
});

export async function registerBoardTaskRoutes(
  server: FastifyInstance,
  board: BoardTaskService,
): Promise<void> {
  server.get("/api/board/tasks", async () => board.list());

  server.get("/api/board/workspaces", async () => board.workspaces());

  server.post("/api/board/tasks", async (request, reply) => {
    const body = createSchema.parse(request.body);
    return reply.status(201).send(await board.create(body));
  });

  server.get<{ Params: { taskId: string } }>("/api/board/tasks/:taskId", async (request) =>
    board.get(request.params.taskId),
  );

  server.patch<{ Params: { taskId: string } }>("/api/board/tasks/:taskId", async (request) => {
    const body = updateSchema.parse(request.body);
    return board.update(request.params.taskId, body);
  });

  server.delete<{ Params: { taskId: string } }>(
    "/api/board/tasks/:taskId",
    async (request, reply) => {
      await board.remove(request.params.taskId);
      return reply.status(204).send();
    },
  );

  server.post<{ Params: { taskId: string } }>("/api/board/tasks/:taskId/start", async (request) =>
    board.start(request.params.taskId),
  );

  server.post<{ Params: { taskId: string } }>("/api/board/tasks/:taskId/confirm", async (request) =>
    board.confirm(request.params.taskId),
  );
}

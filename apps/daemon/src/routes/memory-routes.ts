import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { MemoryService } from "../memory/memory-service";

const createSchema = z.object({
  content: z.string().min(1).max(2_000),
  title: z.string().min(1).max(120).optional(),
});

const updateSchema = z.object({
  content: z.string().min(1).max(2_000).optional(),
  title: z.string().min(1).max(120).optional(),
});

export async function registerMemoryRoutes(
  server: FastifyInstance,
  memory: MemoryService,
): Promise<void> {
  server.get("/api/memories", async () => memory.list());

  server.get<{ Querystring: { limit?: string; q?: string } }>(
    "/api/memories/search",
    async (request, reply) => {
      const query = request.query.q?.trim() ?? "";
      if (query === "" || query.length > 500) {
        return reply.status(400).send({ code: "INVALID_INPUT", message: "q 必须为 1-500 个字符" });
      }
      const limit = request.query.limit === undefined ? 10 : Number(request.query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        return reply.status(400).send({ code: "INVALID_INPUT", message: "limit 必须为 1-50" });
      }
      return await memory.search(query, limit);
    },
  );

  server.post("/api/memories", async (request, reply) => {
    const body = createSchema.parse(request.body);
    return reply.status(201).send(await memory.create(body));
  });

  server.get<{ Params: { memoryId: string } }>("/api/memories/:memoryId", async (request) =>
    memory.get(request.params.memoryId),
  );

  server.patch<{ Params: { memoryId: string } }>("/api/memories/:memoryId", async (request) => {
    const body = updateSchema.parse(request.body);
    return await memory.update(request.params.memoryId, body);
  });

  server.delete<{ Params: { memoryId: string } }>(
    "/api/memories/:memoryId",
    async (request, reply) => {
      memory.delete(request.params.memoryId);
      return reply.status(204).send();
    },
  );
}

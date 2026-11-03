import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { matchesTriggerCondition, type WorkflowService } from "../services/workflow-service";

const nodeSchema = z.object({
  agentType: z.enum(["explorer", "reviewer", "worker"]).optional(),
  dependsOn: z.array(z.string().min(1).max(64)).max(8).optional(),
  id: z.string().min(1).max(64),
  task: z.string().min(1).max(20_000),
  title: z.string().min(1).max(120).optional(),
});

const conditionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("always") }),
  z.object({ type: z.literal("fileMatches"), value: z.string().min(1).max(500) }),
  z.object({ type: z.literal("webhookContains"), value: z.string().min(1).max(500) }),
]);

const createSchema = z.object({
  fileWatchEnabled: z.boolean().optional(),
  fileWatchPaths: z.array(z.string().min(1).max(500)).max(16).optional(),
  nodes: z.array(nodeSchema).min(1).max(12),
  scheduleCron: z.string().min(1).max(120).nullable().optional(),
  scheduleIntervalMinutes: z.number().int().min(1).max(10_080).nullable().optional(),
  scheduleTimezone: z.string().min(1).max(100).nullable().optional(),
  title: z.string().min(1).max(120),
  triggerCondition: conditionSchema.optional(),
  webhookEnabled: z.boolean().optional(),
});

const updateSchema = z.object({
  fileWatchEnabled: z.boolean().optional(),
  fileWatchPaths: z.array(z.string().min(1).max(500)).max(16).optional(),
  nodes: z.array(nodeSchema).min(1).max(12).optional(),
  scheduleCron: z.string().min(1).max(120).nullable().optional(),
  scheduleIntervalMinutes: z.number().int().min(1).max(10_080).nullable().optional(),
  scheduleTimezone: z.string().min(1).max(100).nullable().optional(),
  title: z.string().min(1).max(120).optional(),
  triggerCondition: conditionSchema.optional(),
  webhookEnabled: z.boolean().optional(),
});

const runSchema = z.object({
  workspaceRoot: z.string().min(1).max(4_096).optional(),
});

export async function registerWorkflowRoutes(
  server: FastifyInstance,
  workflows: WorkflowService,
): Promise<void> {
  server.get("/api/workflows", async () => workflows.list());

  server.post("/api/workflows", async (request, reply) => {
    const body = createSchema.parse(request.body);
    return reply.status(201).send(workflows.create(body));
  });

  server.get<{ Params: { workflowId: string } }>("/api/workflows/:workflowId", async (request) =>
    workflows.get(request.params.workflowId),
  );

  server.get<{ Params: { workflowId: string } }>(
    "/api/workflows/:workflowId/runs",
    async (request) => workflows.history(request.params.workflowId),
  );

  server.put<{ Params: { workflowId: string } }>("/api/workflows/:workflowId", async (request) => {
    const body = updateSchema.parse(request.body);
    return workflows.update(request.params.workflowId, body);
  });

  server.delete<{ Params: { workflowId: string } }>(
    "/api/workflows/:workflowId",
    async (request, reply) => {
      workflows.delete(request.params.workflowId);
      return reply.status(204).send();
    },
  );

  server.post<{ Params: { workflowId: string }; Querystring: { token?: string } }>(
    "/api/workflows/:workflowId/webhook",
    async (request, reply) => {
      const token = request.query.token ?? "";
      if (token === "") {
        return reply.status(401).send({ code: "INVALID_TOKEN", message: "缺少 webhook token" });
      }
      const workflow = workflows.verifyWebhook(request.params.workflowId, token);
      const payload = JSON.stringify(request.body ?? "");
      if (
        !matchesTriggerCondition(workflow.triggerCondition, {
          kind: "webhook",
          value: payload,
        })
      ) {
        return reply.status(202).send({ skipped: true });
      }
      const result = await workflows.runTriggered(request.params.workflowId);
      if (result === null) {
        return reply.status(409).send({ code: "BUSY", message: "工作流上一次运行尚未结束" });
      }
      return reply.status(202).send(result);
    },
  );

  server.post<{ Params: { workflowId: string } }>(
    "/api/workflows/:workflowId/run",
    async (request, reply) => {
      const body = runSchema.parse(request.body ?? {});
      const result = await workflows.run(request.params.workflowId, body.workspaceRoot);
      return reply.status(202).send(result);
    },
  );
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProviderOAuthService } from "../services/provider-oauth-service";

const answerSchema = z.object({ promptId: z.string().min(1).max(64), value: z.string().max(4096) });

export async function registerProviderOAuthRoutes(
  server: FastifyInstance,
  oauth: ProviderOAuthService,
): Promise<void> {
  server.get("/api/providers/oauth", async () => oauth.listProviders());

  server.post<{ Params: { providerId: string } }>(
    "/api/providers/:providerId/oauth",
    async (request) => oauth.start(request.params.providerId),
  );

  server.get<{ Params: { loginId: string } }>("/api/providers/oauth/:loginId", async (request) =>
    oauth.get(request.params.loginId),
  );

  server.post<{ Params: { loginId: string } }>(
    "/api/providers/oauth/:loginId/prompt",
    async (request) => {
      const body = answerSchema.parse(request.body);
      return oauth.answer(request.params.loginId, body.promptId, body.value);
    },
  );

  server.delete<{ Params: { loginId: string } }>("/api/providers/oauth/:loginId", async (request) =>
    oauth.cancel(request.params.loginId),
  );

  server.delete<{ Params: { providerId: string } }>(
    "/api/providers/:providerId/oauth/credential",
    async (request, reply) => {
      await oauth.logout(request.params.providerId);
      return reply.status(204).send();
    },
  );
}

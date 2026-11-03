import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { GitService } from "../services/git-service";
import type { SessionController } from "../services/session-types";

const pathsSchema = z.object({
  paths: z.array(z.string().min(1).max(4_096)).min(1).max(100),
});
const commitSchema = z.object({ message: z.string().min(1).max(500) });

export async function registerGitRoutes(
  server: FastifyInstance,
  git: GitService,
  sessions: SessionController,
): Promise<void> {
  server.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/git/status",
    async (request) => {
      const session = sessions.getSession(request.params.sessionId);
      return git.status(session.workspaceRoot);
    },
  );

  server.get<{
    Params: { sessionId: string };
    Querystring: { path?: string; staged?: string };
  }>("/api/sessions/:sessionId/git/diff", async (request) => {
    const session = sessions.getSession(request.params.sessionId);
    return {
      diff: await git.diff(session.workspaceRoot, request.query.path, request.query.staged === "1"),
    };
  });

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/git/stage",
    async (request) => {
      const session = sessions.getSession(request.params.sessionId);
      const body = pathsSchema.parse(request.body);
      await git.stage(session.workspaceRoot, body.paths);
      return git.status(session.workspaceRoot);
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/git/unstage",
    async (request) => {
      const session = sessions.getSession(request.params.sessionId);
      const body = pathsSchema.parse(request.body);
      await git.unstage(session.workspaceRoot, body.paths);
      return git.status(session.workspaceRoot);
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/git/commit",
    async (request) => {
      const session = sessions.getSession(request.params.sessionId);
      const body = commitSchema.parse(request.body);
      const output = await git.commit(session.workspaceRoot, body.message);
      return { output, status: await git.status(session.workspaceRoot) };
    },
  );
}

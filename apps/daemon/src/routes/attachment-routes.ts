import type { FastifyInstance } from "fastify";
import type { AttachmentService } from "../services/attachment-service";
import type { SessionController } from "../services/session-types";

export async function registerAttachmentRoutes(
  server: FastifyInstance,
  attachments: AttachmentService,
  sessions: SessionController,
): Promise<void> {
  server.get<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/attachments",
    async (request) => {
      sessions.getSession(request.params.sessionId);
      return attachments.list(request.params.sessionId);
    },
  );

  server.post<{ Params: { sessionId: string } }>(
    "/api/sessions/:sessionId/attachments",
    async (request, reply) => {
      sessions.getSession(request.params.sessionId);
      const file = await request.file();
      if (file === undefined) {
        return reply.status(400).send({ code: "INVALID", message: "缺少上传文件" });
      }
      const buffer = await file.toBuffer();
      const uploaded = await attachments.upload({
        buffer,
        fileName: file.filename,
        sessionId: request.params.sessionId,
      });
      return reply.status(201).send(uploaded);
    },
  );

  server.delete<{ Params: { attachmentId: string; sessionId: string } }>(
    "/api/sessions/:sessionId/attachments/:attachmentId",
    async (request, reply) => {
      attachments.delete(request.params.attachmentId, request.params.sessionId);
      return reply.status(204).send();
    },
  );
}

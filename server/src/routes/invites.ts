import type { FastifyInstance } from "fastify";
import type { PdsClient } from "../pdsClient.js";
import { requireAuth } from "../auth.js";
import { recordAction } from "../auditLog.js";

export function registerInviteRoutes(app: FastifyInstance, pds: PdsClient) {
  app.get("/api/invites", { preHandler: requireAuth }, async () => {
    return pds.getInviteCodes();
  });

  app.post("/api/invites", { preHandler: requireAuth }, async (req) => {
    const { useCount } = (req.body ?? {}) as { useCount?: number };
    const { code } = await pds.createInviteCode(Math.min(Math.max(useCount ?? 1, 1), 100));
    await recordAction({ operator: req.session.operator!, action: "invite-created", target: code });
    return { code };
  });

  app.post("/api/invites/disable", { preHandler: requireAuth }, async (req) => {
    const { code } = req.body as { code: string };
    await pds.disableInviteCodes([code]);
    await recordAction({ operator: req.session.operator!, action: "invite-disabled", target: code });
    return { ok: true };
  });
}

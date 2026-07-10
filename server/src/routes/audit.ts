import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { readRecent } from "../auditLog.js";

export function registerAuditRoutes(app: FastifyInstance) {
  app.get("/api/audit", { preHandler: requireAuth }, async (req) => {
    const { limit } = req.query as { limit?: string };
    const n = Math.min(Math.max(Number(limit) || 50, 1), 500);
    return { entries: await readRecent(n) };
  });
}

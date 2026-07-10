import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";

declare module "@fastify/session" {
  interface FastifySessionObject {
    operator?: string;
  }
}

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export function registerAuthRoutes(
  app: FastifyInstance,
  passwordHash: string | null,
  appviewUrl: string,
  pdsHostname: string,
) {
  const attempts = new Map<string, { count: number; resetAt: number }>();

  app.post("/api/login", async (req, reply) => {
    if (!passwordHash) {
      return reply.code(403).send({ error: "password sign-in is disabled" });
    }
    const now = Date.now();
    const entry = attempts.get(req.ip);
    if (entry && entry.resetAt <= now) attempts.delete(req.ip);
    if (entry && entry.resetAt > now && entry.count >= MAX_ATTEMPTS) {
      return reply.code(429).send({ error: "too many attempts — try again later" });
    }

    const { password } = req.body as { password?: string };
    if (!password || !bcrypt.compareSync(password, passwordHash)) {
      const current = attempts.get(req.ip);
      if (current && current.resetAt > now) current.count += 1;
      else attempts.set(req.ip, { count: 1, resetAt: now + WINDOW_MS });
      return reply.code(401).send({ error: "invalid credentials" });
    }
    attempts.delete(req.ip);
    req.session.operator = "operator";
    return { ok: true };
  });

  app.post("/api/logout", async (req) => {
    await req.session.destroy();
    return { ok: true };
  });

  app.get("/api/session", async (req) => {
    return {
      authenticated: Boolean(req.session.operator),
      appviewUrl,
      pdsHostname,
      passwordLogin: Boolean(passwordHash),
    };
  });
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  if (!req.session.operator) {
    reply.code(401).send({ error: "not authenticated" });
  }
}

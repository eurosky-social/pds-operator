import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { checkEnrollToken, consumeEnrollToken, type Db } from "../db.js";
import { requireAuth } from "../auth.js";
import { recordAction } from "../auditLog.js";

declare module "@fastify/session" {
  interface FastifySessionObject {
    webauthnChallenge?: string;
  }
}

interface PasskeyRow {
  id: string;
  public_key: Buffer;
  counter: number;
  transports: string | null;
  name: string | null;
  created_at: number;
}

// The dashboard runs on localhost in dev and its real domain in prod; derive the
// WebAuthn relying-party ID from the request so credentials bind to whichever host
// the operator is actually using.
function rpFromRequest(req: FastifyRequest): { rpID: string; origin: string } {
  const origin = (req.headers.origin as string | undefined) ?? `http://${req.headers.host}`;
  return { rpID: new URL(origin).hostname, origin };
}

export function registerPasskeyRoutes(app: FastifyInstance, db: Db, pdsHostname: string) {
  const allPasskeys = () => db.prepare("SELECT * FROM passkeys").all() as PasskeyRow[];

  // Enrollment is authorized by an operator session OR a one-time token minted by
  // the CLI (`npm run enroll`) — the bootstrap path for passkey-only deployments.
  // Guessing tokens is rate-limited per IP on top of the 15-minute expiry.
  const enrollAttempts = new Map<string, { count: number; resetAt: number }>();
  function enrollAuthorized(req: FastifyRequest): boolean {
    if (req.session.operator) return true;
    const token = (req.body as { enrollToken?: string } | null)?.enrollToken;
    if (!token) return false;
    const now = Date.now();
    const entry = enrollAttempts.get(req.ip);
    if (entry && entry.resetAt <= now) enrollAttempts.delete(req.ip);
    const current = enrollAttempts.get(req.ip);
    if (current && current.count >= 5) return false;
    if (checkEnrollToken(db, token)) return true;
    if (current) current.count += 1;
    else enrollAttempts.set(req.ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return false;
  }

  // ---- enrollment (session or one-time CLI token) --------------------------

  app.post("/api/passkeys/options", async (req, reply) => {
    if (!enrollAuthorized(req)) return reply.code(401).send({ error: "not authorized" });
    const { rpID } = rpFromRequest(req);
    const options = await generateRegistrationOptions({
      rpName: `${pdsHostname} admin`,
      rpID,
      userName: "operator",
      attestationType: "none",
      excludeCredentials: allPasskeys().map((p) => ({
        id: p.id,
        transports: p.transports ? (JSON.parse(p.transports) as AuthenticatorTransportFuture[]) : undefined,
      })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    });
    req.session.webauthnChallenge = options.challenge;
    return options;
  });

  app.post("/api/passkeys", async (req, reply) => {
    if (!enrollAuthorized(req)) return reply.code(401).send({ error: "not authorized" });
    const { rpID, origin } = rpFromRequest(req);
    const { name, response, enrollToken } = req.body as {
      name?: string;
      response: any;
      enrollToken?: string;
    };
    const expectedChallenge = req.session.webauthnChallenge;
    req.session.webauthnChallenge = undefined;
    if (!expectedChallenge) return reply.code(400).send({ error: "no pending registration" });

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    }).catch((err) => {
      req.log.warn({ err }, "passkey registration failed");
      return null;
    });
    if (!verification?.verified || !verification.registrationInfo) {
      return reply.code(400).send({ error: "passkey verification failed" });
    }

    // consume the one-time token only after a verified registration
    if (!req.session.operator) {
      if (!enrollToken || !consumeEnrollToken(db, enrollToken)) {
        return reply.code(401).send({ error: "enrollment link expired" });
      }
      req.session.operator = "operator"; // enrolling the passkey signs you in
    }

    const { credential } = verification.registrationInfo;
    db.prepare(
      "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      name?.trim() || null,
      Date.now(),
    );
    await recordAction({
      operator: req.session.operator!,
      action: "passkey-added",
      target: credential.id,
    });
    return { ok: true };
  });

  app.get("/api/passkeys", { preHandler: requireAuth }, async () => {
    return {
      passkeys: allPasskeys().map((p) => ({
        id: p.id,
        name: p.name ?? "unnamed",
        createdAt: p.created_at,
      })),
    };
  });

  app.delete("/api/passkeys/:id", { preHandler: requireAuth }, async (req) => {
    const { id } = req.params as { id: string };
    db.prepare("DELETE FROM passkeys WHERE id = ?").run(id);
    await recordAction({ operator: req.session.operator!, action: "passkey-removed", target: id });
    return { ok: true };
  });

  // ---- sign-in (no session yet) --------------------------------------------

  app.post("/api/login/passkey/options", async (req, reply) => {
    if (allPasskeys().length === 0) {
      return reply.code(400).send({ error: "no passkeys enrolled" });
    }
    const { rpID } = rpFromRequest(req);
    const options = await generateAuthenticationOptions({
      rpID,
      userVerification: "preferred",
      allowCredentials: allPasskeys().map((p) => ({
        id: p.id,
        transports: p.transports ? (JSON.parse(p.transports) as AuthenticatorTransportFuture[]) : undefined,
      })),
    });
    req.session.webauthnChallenge = options.challenge;
    return options;
  });

  app.post("/api/login/passkey", async (req, reply) => {
    const { rpID, origin } = rpFromRequest(req);
    const response = req.body as any;
    const expectedChallenge = req.session.webauthnChallenge;
    req.session.webauthnChallenge = undefined;
    if (!expectedChallenge) return reply.code(400).send({ error: "no pending authentication" });

    const row = db.prepare("SELECT * FROM passkeys WHERE id = ?").get(response?.id) as
      | PasskeyRow
      | undefined;
    if (!row) return reply.code(401).send({ error: "unknown passkey" });

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: row.id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: row.transports
          ? (JSON.parse(row.transports) as AuthenticatorTransportFuture[])
          : undefined,
      },
    }).catch((err) => {
      req.log.warn({ err }, "passkey authentication failed");
      return null;
    });
    if (!verification?.verified) {
      return reply.code(401).send({ error: "passkey verification failed" });
    }

    db.prepare("UPDATE passkeys SET counter = ? WHERE id = ?").run(
      verification.authenticationInfo.newCounter,
      row.id,
    );
    req.session.operator = "operator";
    return { ok: true };
  });
}

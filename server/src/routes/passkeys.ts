import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import { checkEnrollToken, consumeEnrollToken, peekEnrollToken, type Db } from "../db.js";
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
  operator_did: string | null;
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

  /** The pending operator a valid OAuth-minted enroll token belongs to, if any. */
  const tokenOperator = (req: FastifyRequest): { did: string; handle: string } | null => {
    const token = (req.body as { enrollToken?: string } | null)?.enrollToken;
    if (!token) return null;
    const info = peekEnrollToken(db, token);
    if (!info?.operatorDid) return null;
    const row = db
      .prepare("SELECT handle FROM operators WHERE did = ? AND enrolled_at IS NULL")
      .get(info.operatorDid) as { handle: string } | undefined;
    return row ? { did: info.operatorDid, handle: row.handle } : null;
  };

  // Enrollment is authorized by an operator session OR a one-time token — minted by
  // the CLI (`npm run enroll`, the bootstrap path) or by the OAuth callback for an
  // invited admin. Guessing tokens is rate-limited per IP on top of the 15-minute
  // expiry.
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
      userName: tokenOperator(req)?.handle ?? req.session.operator ?? "operator",
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

    // bind the passkey to its owner. tokens are consumed only after the verified
    // registration: a CLI token signs in as the generic operator, an OAuth-minted
    // token carries the invited admin's DID and completes their one-shot enrollment
    let operatorDid: string | null = null;
    if (!req.session.operator) {
      const consumed = enrollToken ? consumeEnrollToken(db, enrollToken) : null;
      if (!consumed) {
        return reply.code(401).send({ error: "enrollment link expired" });
      }
      if (consumed.operatorDid) {
        const op = db
          .prepare("SELECT handle FROM operators WHERE did = ? AND enrolled_at IS NULL")
          .get(consumed.operatorDid) as { handle: string } | undefined;
        if (!op) {
          return reply.code(401).send({ error: "this admin enrollment is no longer open" });
        }
        operatorDid = consumed.operatorDid;
        db.prepare("UPDATE operators SET enrolled_at = ? WHERE did = ?").run(
          Date.now(),
          consumed.operatorDid,
        );
        req.session.operator = op.handle;
      } else {
        req.session.operator = "operator";
      }
    } else {
      // an already signed-in named admin adding another device keeps ownership
      const owner = db
        .prepare("SELECT did FROM operators WHERE handle = ?")
        .get(req.session.operator) as { did: string } | undefined;
      operatorDid = owner?.did ?? null;
    }

    const { credential } = verification.registrationInfo;
    db.prepare(
      "INSERT INTO passkeys (id, public_key, counter, transports, name, created_at, operator_did) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      credential.id,
      Buffer.from(credential.publicKey),
      credential.counter,
      JSON.stringify(credential.transports ?? []),
      name?.trim() || null,
      Date.now(),
      operatorDid,
    );
    await recordAction({
      operator: req.session.operator!,
      action: "passkey-added",
      target: credential.id,
    });
    return { ok: true };
  });

  app.get("/api/passkeys", { preHandler: requireAuth }, async () => {
    const handleFor = db.prepare("SELECT handle FROM operators WHERE did = ?");
    return {
      passkeys: allPasskeys().map((p) => ({
        id: p.id,
        name: p.name ?? "unnamed",
        createdAt: p.created_at,
        operator: p.operator_did
          ? ((handleFor.get(p.operator_did) as { handle: string } | undefined)?.handle ?? null)
          : null,
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
    const owner = row.operator_did
      ? (db.prepare("SELECT handle FROM operators WHERE did = ?").get(row.operator_did) as
          | { handle: string }
          | undefined)
      : undefined;
    req.session.operator = owner?.handle ?? "operator";
    return { ok: true };
  });
}

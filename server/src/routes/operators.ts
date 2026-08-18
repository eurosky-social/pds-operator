import type { FastifyInstance } from "fastify";
import { isHandle, type Did } from "@atcute/lexicons/syntax";
import { createEnrollToken, type Db } from "../db.js";
import type { DashboardOAuthClient } from "../oauth.js";
import { resolveHandleToDid } from "../notifier.js";
import { requireAuth } from "../auth.js";
import { recordAction } from "../auditLog.js";

interface OperatorRow {
  did: string;
  handle: string;
  added_at: number;
  enrolled_at: number | null;
}

export function registerOperatorRoutes(
  app: FastifyInstance,
  db: Db,
  pdsHostname: string,
  oauth: DashboardOAuthClient,
  dashboardUrl: string,
) {
  const pendingExists = () =>
    Boolean(db.prepare("SELECT 1 FROM operators WHERE enrolled_at IS NULL LIMIT 1").get());

  // the PDS (and any authorization server) fetches this to learn about the client
  app.get("/oauth/client-metadata.json", async () => oauth.metadata);

  // ---- enrollment flow: OAuth proves the DID, then a passkey is created ----

  app.get("/api/oauth/start", async (req, reply) => {
    const raw = (req.query as { handle?: string }).handle ?? "";
    const handle = raw.trim().replace(/^@/, "").toLowerCase();
    if (!isHandle(handle)) return reply.code(400).send({ error: "invalid handle" });
    // don't bounce anyone to their PDS unless there is actually an open invite;
    // the callback re-checks the specific DID either way
    if (!pendingExists()) return reply.code(403).send({ error: "no pending admins" });
    try {
      const { url } = await oauth.authorize({
        target: { type: "account", identifier: handle },
      });
      return reply.redirect(url.toString());
    } catch (err) {
      req.log.warn({ err, handle }, "oauth authorize failed");
      return reply.redirect(errorUrl("could not reach that account's server"));
    }
  });

  // redirects out of the callback are absolute: in dev the callback runs on the
  // 127.0.0.1 loopback origin (required by the OAuth spec) but WebAuthn and the
  // operator's session live on the dashboard origin, so send them back there
  const errorUrl = (msg: string) => `${dashboardUrl}/?adminError=${encodeURIComponent(msg)}`;

  app.get("/api/oauth/callback", async (req, reply) => {
    const params = new URLSearchParams(req.query as Record<string, string>);
    let did: Did;
    try {
      const { session } = await oauth.callback(params);
      did = session.did;
      // authentication only: the tokens have done their job the moment we know the DID
      void oauth.revoke(did).catch(() => {});
    } catch (err) {
      req.log.warn({ err }, "oauth callback failed");
      return reply.redirect(errorUrl("sign-in failed, try again"));
    }
    const row = db.prepare("SELECT * FROM operators WHERE did = ?").get(did) as
      | OperatorRow
      | undefined;
    if (!row) {
      return reply.redirect(errorUrl("this account is not an invited admin"));
    }
    if (row.enrolled_at != null) {
      return reply.redirect(errorUrl("this admin is already enrolled, sign in with your passkey"));
    }
    // hand the proven DID to the enrollment flow as a one-time token, the same
    // mechanism CLI enroll links use
    const { token } = createEnrollToken(db, did);
    return reply.redirect(`${dashboardUrl}/?enroll=${token}`);
  });

  // ---- admin management ----------------------------------------------------

  app.get("/api/operators", { preHandler: requireAuth }, async () => {
    // avatar comes along for admins that are accounts on this PDS
    const rows = db
      .prepare(
        `SELECT o.*, a.avatar FROM operators o
         LEFT JOIN accounts a ON a.did = o.did ORDER BY o.added_at`,
      )
      .all() as (OperatorRow & { avatar: string | null })[];
    const count = db.prepare("SELECT COUNT(*) AS n FROM passkeys WHERE operator_did = ?");
    return {
      operators: rows.map((r) => ({
        did: r.did,
        handle: r.handle,
        avatar: r.avatar ?? undefined,
        addedAt: r.added_at,
        enrolledAt: r.enrolled_at,
        passkeys: (count.get(r.did) as { n: number }).n,
      })),
    };
  });

  app.post("/api/operators", { preHandler: requireAuth }, async (req, reply) => {
    const raw = (req.body as { handle?: string })?.handle ?? "";
    const handle = raw.trim().replace(/^@/, "").toLowerCase();
    if (!handle) return reply.code(400).send({ error: "handle required" });
    let did: string;
    try {
      did = await resolveHandleToDid(pdsHostname, handle);
    } catch {
      return reply.code(400).send({ error: `could not resolve ${handle}` });
    }
    const exists = db.prepare("SELECT 1 FROM operators WHERE did = ?").get(did);
    if (exists) return reply.code(409).send({ error: "already an admin" });
    db.prepare("INSERT INTO operators (did, handle, added_at) VALUES (?, ?, ?)").run(
      did,
      handle,
      Date.now(),
    );
    await recordAction({ operator: req.session.operator!, action: "admin-added", target: did });
    return { ok: true, did };
  });

  // removing and re-adding an admin is also the recovery path: it deletes their
  // passkeys and reopens the one-shot OAuth enrollment
  app.delete("/api/operators/:did", { preHandler: requireAuth }, async (req, reply) => {
    const { did } = req.params as { did: string };
    const row = db.prepare("SELECT 1 FROM operators WHERE did = ?").get(did);
    if (!row) return reply.code(404).send({ error: "not an admin" });
    db.transaction(() => {
      db.prepare("DELETE FROM passkeys WHERE operator_did = ?").run(did);
      db.prepare("DELETE FROM operators WHERE did = ?").run(did);
    })();
    await recordAction({ operator: req.session.operator!, action: "admin-removed", target: did });
    return { ok: true };
  });
}

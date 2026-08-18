import "dotenv/config";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import fastifyStatic from "@fastify/static";
import fastifyHelmet from "@fastify/helmet";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { PdsClient } from "./pdsClient.js";
import { RelayClient } from "./relayClient.js";
import { LabelerClient, fetchLabelNames, type WatchedLabeler } from "./labelerClient.js";
import { openDb } from "./db.js";
import { Syncer } from "./sync.js";
import { registerAuthRoutes } from "./auth.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerStatusRoutes } from "./routes/status.js";
import { registerPasskeyRoutes } from "./routes/passkeys.js";
import { registerAuditRoutes } from "./routes/audit.js";
import { registerInviteRoutes } from "./routes/invites.js";
import { registerStatsRoutes } from "./routes/stats.js";
import { BskyDmNotifier } from "./notifier.js";

const {
  PDS_HOSTNAME,
  PDS_ADMIN_PASSWORD,
  PDS_ADMIN_IDENTIFIER,
  RELAY_HOSTNAME,
  OPERATOR_PASSWORD_HASH,
  SESSION_SECRET,
  PORT,
} = process.env;

for (const [name, val] of Object.entries({
  PDS_HOSTNAME,
  PDS_ADMIN_PASSWORD,
  RELAY_HOSTNAME,
  SESSION_SECRET,
})) {
  if (!val) throw new Error(`missing required env var: ${name}`);
}

const isProd = process.env.NODE_ENV === "production";

// forged operator sessions are game over — refuse to boot on a weak secret
if (isProd && (SESSION_SECRET!.length < 32 || SESSION_SECRET!.includes("not-for-prod"))) {
  throw new Error("SESSION_SECRET must be a strong random value in production (openssl rand -hex 32)");
}

// trustProxy: in production the app binds to loopback behind a TLS-terminating
// reverse proxy, so X-Forwarded-For is trustworthy and req.ip (login rate
// limiting) reflects the real client
const app = Fastify({ logger: true, trustProxy: true });

await app.register(fastifyHelmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "https:", "data:"], // avatars come from the PDS blob endpoint
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
});

await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: SESSION_SECRET!,
  cookie: {
    secure: isProd,
    httpOnly: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 12,
  },
});

const pds = new PdsClient(PDS_HOSTNAME!, PDS_ADMIN_PASSWORD!, PDS_ADMIN_IDENTIFIER || undefined);
const relay = new RelayClient(RELAY_HOSTNAME!);
// labelers.json: [{ "name"?, "did", "labels": [...] }] — labels empty/omitted means all labels flag.
// Falls back to LABELER_DID / FLAG_LABELS env vars if the file doesn't exist.
const labelersPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../labelers.json");
let labelerConfigs: { did: string; labels?: string[] }[] = [];
if (existsSync(labelersPath)) {
  labelerConfigs = JSON.parse(readFileSync(labelersPath, "utf8"));
} else if (process.env.LABELER_DID) {
  labelerConfigs = [
    {
      did: process.env.LABELER_DID,
      labels: (process.env.FLAG_LABELS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    },
  ];
}
const labelers: WatchedLabeler[] = labelerConfigs.map((c) => ({
  did: c.did,
  client: new LabelerClient(c.did),
  watch: new Set(c.labels ?? []),
}));

// flag notifications via Bluesky DM — enabled only when all four vars are set
const { NOTIFY_HANDLE, NOTIFY_APP_PASSWORD, NOTIFY_RECIPIENT, DASHBOARD_URL } = process.env;
const notifier =
  NOTIFY_HANDLE && NOTIFY_APP_PASSWORD && NOTIFY_RECIPIENT && DASHBOARD_URL
    ? new BskyDmNotifier(
        {
          handle: NOTIFY_HANDLE,
          appPassword: NOTIFY_APP_PASSWORD,
          recipient: NOTIFY_RECIPIENT,
          dashboardUrl: DASHBOARD_URL.replace(/\/$/, ""),
          pdsHostname: PDS_HOSTNAME!,
        },
        app.log,
      )
    : null;
if (!notifier) app.log.info("flag DM notifications disabled (NOTIFY_* env vars not set)");

// human-readable label names per labeler (src -> val -> display name), loaded in the
// background; raw identifiers are shown until each fetch lands
const labelNames = new Map<string, Map<string, string>>();
for (const l of labelers) {
  void fetchLabelNames(l.did)
    .then((names) => labelNames.set(l.did, names))
    .catch((err) => app.log.warn({ err, labeler: l.did }, "label names fetch failed"));
}

// DM when one account creates this many records within the window; 0 disables.
// Needs the notifier (NOTIFY_* vars) to have somewhere to send the alert.
const alertCreates = Number(process.env.ACTIVITY_ALERT_CREATES ?? 500);
const alertWindowMinutes = Number(process.env.ACTIVITY_ALERT_WINDOW_MINUTES ?? 60);
const activityAlert =
  notifier && Number.isFinite(alertCreates) && alertCreates > 0 &&
  Number.isFinite(alertWindowMinutes) && alertWindowMinutes > 0
    ? { creates: alertCreates, windowMinutes: alertWindowMinutes }
    : null;
if (notifier && !activityAlert) {
  app.log.info("record creation burst alerts disabled (ACTIVITY_ALERT_CREATES=0)");
}

const db = openDb();
const syncer = new Syncer(db, pds, labelers, app.log, notifier, labelNames, activityAlert);
syncer.start();

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.once(sig, () => {
    syncer.stop();
    void app.close().finally(() => process.exit(0));
  });
}

const appviewUrl = (process.env.APPVIEW_URL ?? "https://bsky.app").replace(/\/$/, "");

// no password hash = passkey-only; the first passkey comes from `npm run enroll`
if (!OPERATOR_PASSWORD_HASH) {
  const enrolled = db.prepare("SELECT COUNT(*) AS c FROM passkeys").get() as { c: number };
  app.log.info(
    enrolled.c > 0
      ? "password sign-in disabled (passkey-only)"
      : "password sign-in disabled and no passkeys enrolled — run `npm run enroll`",
  );
}

registerAuthRoutes(app, OPERATOR_PASSWORD_HASH ?? null, appviewUrl, PDS_HOSTNAME!);
registerAccountRoutes(app, pds, db, labelers);
registerStatusRoutes(app, pds, relay, PDS_HOSTNAME!, db);
registerPasskeyRoutes(app, db, PDS_HOSTNAME!);
registerAuditRoutes(app);
registerInviteRoutes(app, pds);
registerStatsRoutes(app, pds, db, labelers);

const webDist = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
await app.register(fastifyStatic, { root: webDist });
app.setNotFoundHandler((req, reply) => {
  if (req.raw.url?.startsWith("/api/")) {
    reply.code(404).send({ error: "not found" });
  } else {
    reply.sendFile("index.html");
  }
});

const port = Number(PORT ?? 8787);
// production sits behind a reverse proxy — don't expose the app port directly
const host = process.env.HOST ?? (isProd ? "127.0.0.1" : "0.0.0.0");
app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

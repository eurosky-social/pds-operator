import type { FastifyInstance } from "fastify";
import type { PdsClient } from "../pdsClient.js";
import { RelayClient } from "../relayClient.js";
import { getSyncState, type Db } from "../db.js";
import { requireAuth } from "../auth.js";
import { recordAction } from "../auditLog.js";

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

export function registerStatusRoutes(
  app: FastifyInstance,
  pds: PdsClient,
  relay: RelayClient,
  pdsHostname: string,
  db: Db,
) {
  app.get("/api/status/cursor", { preHandler: requireAuth }, async () => {
    const hostStatus = await relay.getHostStatus(pdsHostname);
    const headSeq = await pds.approximateHeadSeq(hostStatus.seq);
    const gap = headSeq != null ? headSeq - hostStatus.seq : null;
    return {
      relaySeq: hostStatus.seq,
      relayStatus: hostStatus.status,
      accountCount: hostStatus.accountCount,
      pdsHeadSeqApprox: headSeq,
      gap,
      lastFullSync: getSyncState(db, "last_full_sync"),
    };
  });

  app.post("/api/status/request-crawl", { preHandler: requireAuth }, async (req, reply) => {
    const raw = (req.body as { relay?: string } | null)?.relay?.trim();
    let target = relay;
    let relayHostname: string | undefined;
    if (raw) {
      relayHostname = raw.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!HOSTNAME_RE.test(relayHostname)) {
        return reply.code(400).send({ error: "invalid relay hostname" });
      }
      target = new RelayClient(relayHostname);
    }
    await target.requestCrawl(pdsHostname);
    await recordAction({
      operator: req.session.operator!,
      action: "request-crawl",
      target: relayHostname ? `${pdsHostname} via ${relayHostname}` : pdsHostname,
    });
    return { ok: true };
  });
}

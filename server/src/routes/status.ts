import type { FastifyInstance } from "fastify";
import type { PdsClient } from "../pdsClient.js";
import type { RelayClient } from "../relayClient.js";
import { getSyncState, type Db } from "../db.js";
import { requireAuth } from "../auth.js";
import { recordAction } from "../auditLog.js";

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

  app.post("/api/status/request-crawl", { preHandler: requireAuth }, async (req) => {
    await relay.requestCrawl(pdsHostname);
    await recordAction({ operator: req.session.operator!, action: "request-crawl", target: pdsHostname });
    return { ok: true };
  });
}

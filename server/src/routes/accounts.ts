import type { FastifyInstance } from "fastify";
import type { PdsClient } from "../pdsClient.js";
import type { WatchedLabeler } from "../labelerClient.js";
import type { AccountRow, Db, LabelRow } from "../db.js";
import { requireAuth } from "../auth.js";
import { recordAction } from "../auditLog.js";

interface ApiAccount {
  did: string;
  handle: string;
  email?: string;
  indexedAt: string;
  status: string;
  avatar?: string;
  labels: string[];
}

export function registerAccountRoutes(
  app: FastifyInstance,
  pds: PdsClient,
  db: Db,
  labelers: WatchedLabeler[],
  labelNames: Map<string, Map<string, string>>,
) {
  const watchBysrc = new Map(labelers.map((l) => [l.did, l.watch]));

  function isWatched(row: LabelRow): boolean {
    const watch = watchBysrc.get(row.src);
    if (!watch) return false;
    return watch.size === 0 || watch.has(row.val);
  }

  const displayName = (src: string, val: string) => labelNames.get(src)?.get(val) ?? val;

  function toApi(rows: AccountRow[]): ApiAccount[] {
    if (rows.length === 0) return [];
    const params = rows.map(() => "?").join(",");
    const labelRows = db
      .prepare(`SELECT did, src, val, cts FROM labels WHERE did IN (${params})`)
      .all(...rows.map((r) => r.did)) as LabelRow[];
    const labelsByDid = new Map<string, Set<string>>();
    for (const row of labelRows) {
      if (!isWatched(row)) continue;
      const set = labelsByDid.get(row.did) ?? new Set<string>();
      set.add(displayName(row.src, row.val));
      labelsByDid.set(row.did, set);
    }
    return rows.map((r) => ({
      did: r.did,
      handle: r.handle,
      email: r.email ?? undefined,
      indexedAt: r.indexed_at,
      status: r.status,
      avatar: r.avatar ?? undefined,
      labels: [...(labelsByDid.get(r.did) ?? [])].sort(),
    }));
  }

  // SQL predicate for "this account carries a watched label" — used to float flagged
  // accounts to the top of the list
  const flagConds: string[] = [];
  const flagParams: unknown[] = [];
  for (const l of labelers) {
    if (l.watch.size === 0) {
      flagConds.push("l.src = ?");
      flagParams.push(l.did);
    } else {
      flagConds.push(`(l.src = ? AND l.val IN (${[...l.watch].map(() => "?").join(",")}))`);
      flagParams.push(l.did, ...l.watch);
    }
  }
  const flagExpr =
    flagConds.length > 0
      ? `EXISTS (SELECT 1 FROM labels l WHERE l.did = accounts.did AND (${flagConds.join(" OR ")}))`
      : "0";

  app.get("/api/accounts", { preHandler: requireAuth }, async (req) => {
    const query = req.query as {
      q?: string;
      offset?: string;
      limit?: string;
      hideTakendown?: string;
    };
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
    const offset = Math.max(Number(query.offset) || 0, 0);

    const q = query.q?.trim();
    const where: string[] = [];
    const params: unknown[] = [];
    if (q) {
      const pattern = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
      where.push(
        "(handle LIKE ? ESCAPE '\\' OR did LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')",
      );
      params.push(pattern, pattern, pattern);
    }
    if (query.hideTakendown === "1") {
      if (q) {
        // an exact handle/did/email match should surface even when taken down
        where.push(
          "(status != 'takendown' OR handle = ? COLLATE NOCASE OR did = ? OR email = ? COLLATE NOCASE)",
        );
        params.push(q, q, q);
      } else {
        where.push("status != 'takendown'");
      }
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    const { total } = db
      .prepare(`SELECT COUNT(*) AS total FROM accounts ${whereSql}`)
      .get(...params) as { total: number };
    const { flaggedTotal } = db
      .prepare(
        `SELECT COUNT(*) AS flaggedTotal FROM accounts ${whereSql} ${whereSql ? "AND" : "WHERE"} ${flagExpr}`,
      )
      .get(...params, ...flagParams) as { flaggedTotal: number };
    const rows = db
      .prepare(
        `SELECT *, ${flagExpr} AS is_flagged FROM accounts ${whereSql}
         ORDER BY is_flagged DESC, indexed_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...flagParams, ...params, limit, offset) as AccountRow[];

    return { accounts: toApi(rows), total, flaggedTotal };
  });

  app.post("/api/accounts/:did/takedown", { preHandler: requireAuth }, async (req) => {
    const { did } = req.params as { did: string };
    await pds.setAccountTakedown(did, true);
    db.prepare("UPDATE accounts SET status = 'takendown', updated_at = ? WHERE did = ?").run(
      Date.now(),
      did,
    );
    await recordAction({ operator: req.session.operator!, action: "takedown", target: did });
    return { ok: true };
  });

  app.post("/api/accounts/:did/enable", { preHandler: requireAuth }, async (req) => {
    const { did } = req.params as { did: string };
    await pds.setAccountTakedown(did, false);
    db.prepare("UPDATE accounts SET status = 'active', updated_at = ? WHERE did = ?").run(
      Date.now(),
      did,
    );
    await recordAction({ operator: req.session.operator!, action: "enable", target: did });
    return { ok: true };
  });

  app.post("/api/accounts/:did/reset-password", { preHandler: requireAuth }, async (req) => {
    const { did } = req.params as { did: string };
    await pds.resetAccountPassword(did);
    await recordAction({ operator: req.session.operator!, action: "reset-password", target: did });
    return { ok: true };
  });
}

import type { FastifyInstance } from "fastify";
import { watchedLabelPredicate, type WatchedLabeler } from "../labelerClient.js";
import type { Db } from "../db.js";
import { requireAuth } from "../auth.js";

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function registerStatsRoutes(app: FastifyInstance, db: Db, labelers: WatchedLabeler[]) {
  const { expr: flagExpr, params: flagParams } = watchedLabelPredicate(labelers);
  const watchBySrc = new Map(labelers.map((l) => [l.did, l.watch]));
  const isWatched = (src: string, val: string) => {
    const watch = watchBySrc.get(src);
    return !!watch && (watch.size === 0 || watch.has(val));
  };

  app.get("/api/stats", { preHandler: requireAuth }, async (req) => {
    const query = req.query as { days?: string; months?: string; activeDays?: string; tz?: string };
    const days = [7, 30, 90].includes(Number(query.days)) ? Number(query.days) : 30;
    const months = [6, 12, 24].includes(Number(query.months)) ? Number(query.months) : 12;
    const activeDays = [7, 30, 90].includes(Number(query.activeDays))
      ? Number(query.activeDays)
      : 30;
    // day/month buckets follow the viewer's clock; the browser sends its IANA zone
    const tz = query.tz && isValidTimeZone(query.tz) ? query.tz : "UTC";
    const localDay = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: tz });

    const statusRows = db
      .prepare("SELECT status, COUNT(*) AS n FROM accounts GROUP BY status")
      .all() as { status: string; n: number }[];
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = r.n;
    const total = statusRows.reduce((sum, r) => sum + r.n, 0);

    const { flagged } = db
      .prepare(`SELECT COUNT(*) AS flagged FROM accounts WHERE ${flagExpr}`)
      .get(...flagParams) as { flagged: number };

    const now = Date.now();

    // signups per calendar month in the viewer's timezone, trailing `months` incl. empty.
    // indexed_at is a UTC ISO string, so bucket the few hundred rows in JS rather than SQL
    const monthKeys: string[] = [];
    {
      let [y, m] = localDay(new Date(now)).split("-").map(Number);
      for (let i = 0; i < months; i++) {
        monthKeys.unshift(`${y}-${String(m).padStart(2, "0")}`);
        m -= 1;
        if (m === 0) {
          m = 12;
          y -= 1;
        }
      }
    }
    const signupCounts = new Map(monthKeys.map((k) => [k, 0]));
    const indexedRows = db
      .prepare("SELECT indexed_at FROM accounts WHERE indexed_at != ''")
      .all() as { indexed_at: string }[];
    for (const r of indexedRows) {
      const d = new Date(r.indexed_at);
      if (Number.isNaN(d.getTime())) continue;
      const key = localDay(d).slice(0, 7);
      if (signupCounts.has(key)) signupCounts.set(key, signupCounts.get(key)! + 1);
    }
    const signups = monthKeys.map((month) => ({ month, n: signupCounts.get(month)! }));

    // watched labels only, counted by distinct account, merged by raw label value
    const labelRows = db
      .prepare("SELECT src, val, COUNT(DISTINCT did) AS n FROM labels GROUP BY src, val")
      .all() as { src: string; val: string; n: number }[];
    const labelCounts = new Map<string, number>();
    for (const r of labelRows) {
      if (!isWatched(r.src, r.val)) continue;
      labelCounts.set(r.val, (labelCounts.get(r.val) ?? 0) + r.n);
    }
    const labels = [...labelCounts]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
      .slice(0, 12);

    // firehose activity — counted since this server first ran, no backfill. Stored as
    // UTC hours; tiles use rolling windows, the chart regroups hours into local days
    const hourCutoff = (offsetDays: number) =>
      new Date(now - offsetDays * 86_400_000).toISOString().slice(0, 13);
    // active/dormant split excludes taken-down accounts, so the two tiles sum to the
    // account panel's default (hide taken down) count; deactivated counts as dormant
    const { active } = db
      .prepare(
        `SELECT COUNT(DISTINCT ev.did) AS active FROM activity ev
         JOIN accounts a ON a.did = ev.did
         WHERE a.status != 'takendown' AND ev.hour >= ?`,
      )
      .get(hourCutoff(activeDays)) as { active: number };
    const { dormant } = db
      .prepare(
        `SELECT COUNT(*) AS dormant FROM accounts
         WHERE status != 'takendown'
           AND did NOT IN (SELECT DISTINCT did FROM activity WHERE hour >= ?)`,
      )
      .get(hourCutoff(activeDays)) as { dormant: number };
    // fetch one extra day of hours so the oldest local day is fully covered
    const hourRows = db
      .prepare("SELECT hour, SUM(events) AS n FROM activity WHERE hour >= ? GROUP BY hour")
      .all(hourCutoff(days + 1)) as { hour: string; n: number }[];
    const byDay = new Map<string, number>();
    for (const r of hourRows) {
      const day = localDay(new Date(`${r.hour}:00:00Z`));
      byDay.set(day, (byDay.get(day) ?? 0) + r.n);
    }
    const writesByDay: { day: string; n: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const day = localDay(new Date(now - i * 86_400_000));
      writesByDay.push({ day, n: byDay.get(day) ?? 0 });
    }

    // strip totals scoped to the activity period: signups joined, writes made
    const { newAccounts } = db
      .prepare("SELECT COUNT(*) AS newAccounts FROM accounts WHERE indexed_at >= ?")
      .get(new Date(now - activeDays * 86_400_000).toISOString()) as { newAccounts: number };
    const { writes } = db
      .prepare("SELECT COALESCE(SUM(events), 0) AS writes FROM activity WHERE hour >= ?")
      .get(hourCutoff(activeDays)) as { writes: number };

    // average distinct writers per local day. Averaged over days the counter has
    // actually covered (it has no backfill), so a young install isn't dragged to zero
    const pairRows = db
      .prepare("SELECT DISTINCT hour, did FROM activity WHERE hour >= ?")
      .all(hourCutoff(activeDays)) as { hour: string; did: string }[];
    const didsByDay = new Map<string, Set<string>>();
    for (const r of pairRows) {
      const day = localDay(new Date(`${r.hour}:00:00Z`));
      const set = didsByDay.get(day) ?? new Set<string>();
      set.add(r.did);
      didsByDay.set(day, set);
    }
    const firstHour = (
      db.prepare("SELECT MIN(hour) AS h FROM activity").get() as { h: string | null }
    ).h;
    const firstDay = firstHour ? localDay(new Date(`${firstHour}:00:00Z`)) : null;
    let coveredDays = 0;
    let dauSum = 0;
    for (let i = activeDays - 1; i >= 0; i--) {
      const day = localDay(new Date(now - i * 86_400_000));
      if (firstDay == null || day < firstDay) continue;
      coveredDays += 1;
      dauSum += didsByDay.get(day)?.size ?? 0;
    }
    const avgDailyActive = coveredDays > 0 ? dauSum / coveredDays : 0;

    const topAccounts = db
      .prepare(
        `SELECT a.did, a.handle, a.avatar, SUM(ev.events) AS n
         FROM activity ev JOIN accounts a ON a.did = ev.did
         WHERE ev.hour >= ? GROUP BY ev.did ORDER BY n DESC LIMIT 5`,
      )
      .all(hourCutoff(activeDays)) as {
      did: string;
      handle: string;
      avatar: string | null;
      n: number;
    }[];

    return {
      accounts: {
        total,
        active: byStatus.active ?? 0,
        takendown: byStatus.takendown ?? 0,
        deactivated: byStatus.deactivated ?? 0,
        flagged,
      },
      activity: {
        active,
        dormant,
        avgDailyActive,
        newAccounts,
        writes,
        writesByDay,
        topAccounts,
      },
      signups,
      labels,
    };
  });
}

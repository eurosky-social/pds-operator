import type { FastifyBaseLogger } from "fastify";
import type { Db } from "./db.js";
import type { PdsClient } from "./pdsClient.js";
import { recordAction } from "./auditLog.js";

// records deleted per round; the account is lifted out of takedown only for the few
// seconds it takes to delete one chunk, then hidden again before the next round
const CHUNK = 500;
const ROUND_PAUSE_MS = 5_000;
// a round that throws (PDS down, rate limit exhausted) backs off and retries; the job
// only gives up after this many consecutive failures, and the account stays takendown
const MAX_ROUND_FAILURES = 6;
const FAILURE_BACKOFF_MS = 30_000;
// the safety reconciler forces a re-takedown on any account left enabled by a crash
const RECONCILE_MS = 30_000;

export interface PurgeJob {
  did: string;
  status: "pending" | "running" | "done" | "error";
  deleted: number;
  enabled: number;
  error: string | null;
  operator: string;
}

export class PurgeRunner {
  private stopped = false;
  private working = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: Db,
    private pds: PdsClient,
    private log: FastifyBaseLogger,
  ) {}

  /** Queue a purge for an already-taken-down account. Idempotent per did. */
  enqueue(did: string, operator: string): PurgeJob {
    this.db
      .prepare(
        `INSERT INTO purge_jobs (did, status, deleted, enabled, operator, created_at, updated_at)
         VALUES (?, 'pending', 0, 0, ?, ?, ?)
         ON CONFLICT(did) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at`,
      )
      .run(did, operator, Date.now(), Date.now());
    this.kick();
    return this.get(did)!;
  }

  get(did: string): PurgeJob | null {
    return (this.db.prepare("SELECT * FROM purge_jobs WHERE did = ?").get(did) as PurgeJob) ?? null;
  }

  start() {
    // first: force any account a crash left enabled back into takedown
    void this.reconcileEnabled();
    const t = setInterval(() => void this.reconcileEnabled(), RECONCILE_MS);
    t.unref();
    this.timer = t;
    this.kick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  private setStatus(did: string, patch: Partial<PurgeJob>) {
    const cur = this.get(did);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.db
      .prepare(
        "UPDATE purge_jobs SET status = ?, deleted = ?, enabled = ?, error = ?, updated_at = ? WHERE did = ?",
      )
      .run(next.status, next.deleted, next.enabled, next.error ?? null, Date.now(), did);
  }

  /** Re-takedown anything flagged enabled but not actively being worked right now. */
  private async reconcileEnabled() {
    if (this.stopped) return;
    const rows = this.db
      .prepare("SELECT did FROM purge_jobs WHERE enabled = 1")
      .all() as { did: string }[];
    for (const { did } of rows) {
      if (this.working) return; // the active job owns its own enable/disable lifecycle
      try {
        await this.pds.setAccountTakedownStubborn(did, true);
        this.setStatus(did, { enabled: 0 });
        this.log.warn({ did }, "purge reconciler restored a takedown");
      } catch (err) {
        this.log.error({ err, did }, "purge reconciler could not restore takedown");
      }
    }
  }

  private kick() {
    if (this.working || this.stopped) return;
    void this.drain();
  }

  private async drain() {
    if (this.working) return;
    this.working = true;
    try {
      for (;;) {
        if (this.stopped) break;
        const job = this.db
          .prepare("SELECT * FROM purge_jobs WHERE status IN ('pending','running') ORDER BY created_at LIMIT 1")
          .get() as PurgeJob | undefined;
        if (!job) break;
        await this.runJob(job.did);
      }
    } finally {
      this.working = false;
    }
  }

  private async runJob(did: string) {
    this.setStatus(did, { status: "running" });
    let failures = 0;
    while (!this.stopped) {
      let round: { deleted: number; done: boolean } | null = null;
      let roundErr: unknown;
      // enable → delete one chunk → re-takedown, with the account hidden again by
      // the finally no matter how the round ends
      this.setStatus(did, { enabled: 1 });
      try {
        await this.pds.setAccountTakedown(did, false);
        const jwt = await this.pds.signInAsAccount(did);
        round = await this.pds.deleteRecordsChunk(jwt, did, CHUNK);
      } catch (err) {
        roundErr = err;
      } finally {
        try {
          await this.pds.setAccountTakedownStubborn(did, true);
          this.setStatus(did, { enabled: 0 });
        } catch (err) {
          // the PDS won't accept the re-takedown even after stubborn retries: leave
          // enabled = 1 for the reconciler and stop this job rather than delete more
          this.log.error({ err, did }, "purge could not restore takedown, leaving flagged");
          this.setStatus(did, { status: "running", error: "re-takedown pending" });
          return;
        }
      }

      if (roundErr) {
        this.log.warn({ err: roundErr, did, failures }, "purge round failed");
        if (++failures >= MAX_ROUND_FAILURES) {
          this.setStatus(did, { status: "error", error: (roundErr as Error).message });
          return;
        }
        await this.sleep(FAILURE_BACKOFF_MS);
        continue;
      }

      failures = 0;
      const cur = this.get(did);
      const deleted = (cur?.deleted ?? 0) + round!.deleted;
      this.setStatus(did, { deleted });
      this.log.info({ did, deleted, done: round!.done }, "purge round complete");

      if (round!.done) {
        this.setStatus(did, { status: "done", error: null });
        void recordAction({ operator: cur?.operator ?? "operator", action: "purge-records", target: did });
        return;
      }
      await this.sleep(ROUND_PAUSE_MS);
    }
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }
}

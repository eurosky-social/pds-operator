import WebSocket from "ws";
import type { FastifyBaseLogger } from "fastify";
import { readFrame, type PdsClient, type RepoEntry } from "./pdsClient.js";
import { activeLabels, type Label, type WatchedLabeler } from "./labelerClient.js";
import { setSyncState, getSyncState, type Db } from "./db.js";
import type { BskyDmNotifier } from "./notifier.js";

const FULL_SYNC_INTERVAL_MS = 15 * 60 * 1000;
// a changed repo is re-measured at most this often, so busy accounts don't cost a
// CAR download on every sync
const STORAGE_REMEASURE_MS = 6 * 60 * 60 * 1000;
// STORAGE_SWEEP=off skips per-account storage measurement entirely. Its first pass
// downloads every repo CAR and requests every blob, which on a large PDS means
// millions of blob-store reads; with it off the storage column stays empty.
const STORAGE_SWEEP_ENABLED = process.env.STORAGE_SWEEP !== "off";
const DIRTY_FLUSH_MS = 5_000;
const RECONNECT_MS = 10_000;
const FETCH_CONCURRENCY = 4;

/** Run `fn` over `items` with bounded concurrency. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** fetch with retry/backoff on 429 and 5xx — third-party APIs rate limit under fan-out. */
async function fetchWithRetry(url: string, tries = 3): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : 1000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw lastErr ?? new Error(`fetch failed after ${tries} tries: ${url}`);
}

/**
 * Liveness watchdog: a stream socket can go half-dead (no close event, no data —
 * e.g. after a NAT timeout), which would silently stop live updates until restart.
 * Ping every 30s; a missed pong means the connection is gone, so terminate it and
 * let the close handler's reconnect logic take over.
 */
function attachHeartbeat(ws: WebSocket, intervalMs = 30_000) {
  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      ws.terminate(); // fires 'close' → reconnect
      return;
    }
    alive = false;
    ws.ping();
  }, intervalMs);
  timer.unref();
  ws.once("close", () => clearInterval(timer));
}

const ACCOUNT_STREAM_CURSOR_KEY = "account_stream_cursor";

/** DM an alert when one account makes this many record creations within the window. */
export interface ActivityAlertConfig {
  creates: number;
  windowMinutes: number;
}

export function accountStreamUrl(hostname: string, cursor: string | null): string {
  return (
    `wss://${hostname}/xrpc/com.atproto.sync.subscribeRepos` +
    (cursor ? `?cursor=${cursor}` : "")
  );
}

function repoStatusToAccountStatus(repo: RepoEntry): "active" | "takendown" | "deactivated" {
  if (repo.active !== false) return "active";
  return repo.status === "deactivated" ? "deactivated" : "takendown";
}

export class Syncer {
  private dirty = new Set<string>();
  // firehose commit counts buffered as "day|did" -> n, flushed on the dirty interval
  private activity = new Map<string, number>();
  private sockets: WebSocket[] = [];
  private stopped = false;
  private syncing = false;
  private sweepingStorage = false;
  private timers: NodeJS.Timeout[] = [];
  // latest firehose seq, persisted on the flush tick — a write per frame would hammer SQLite
  private accountCursor: number | null = null;
  // record creations per account, bucketed by minute, for burst alerts
  private createBursts = new Map<string, Map<number, number>>();
  private burstAlertedAt = new Map<string, number>();

  constructor(
    private db: Db,
    private pds: PdsClient,
    private labelers: WatchedLabeler[],
    private log: FastifyBaseLogger,
    private notifier: BskyDmNotifier | null = null,
    private labelNames: Map<string, Map<string, string>> = new Map(),
    private activityAlert: ActivityAlertConfig | null = null,
  ) {}

  private isWatched(labeler: WatchedLabeler, val: string): boolean {
    return labeler.watch.size === 0 || labeler.watch.has(val);
  }

  private notifyNewFlags(did: string, vals: string[], src: string) {
    if (!this.notifier || vals.length === 0) return;
    const row = this.db.prepare("SELECT handle FROM accounts WHERE did = ?").get(did) as
      | { handle: string }
      | undefined;
    const names = vals.sort().map((val) => this.labelNames.get(src)?.get(val) ?? val);
    void this.notifier.notifyFlags({ did, handle: row?.handle ?? did }, names);
  }

  start() {
    void this.fullSync().catch((err) => this.log.error({ err }, "initial full sync failed"));
    const syncTimer = setInterval(() => {
      void this.fullSync().catch((err) => this.log.error({ err }, "full sync failed"));
    }, FULL_SYNC_INTERVAL_MS);
    const flushTimer = setInterval(() => {
      void this.flushDirty().catch((err) => this.log.error({ err }, "dirty flush failed"));
      try {
        this.flushActivity();
        this.flushCursor();
        this.pruneCreateBursts();
      } catch (err) {
        this.log.error({ err }, "activity flush failed");
      }
    }, DIRTY_FLUSH_MS);
    for (const t of [syncTimer, flushTimer]) t.unref();
    this.timers.push(syncTimer, flushTimer);

    this.connectAccountStream();
    for (const labeler of this.labelers) this.connectLabelStream(labeler);
    if (!STORAGE_SWEEP_ENABLED) this.log.info("storage sweep disabled (STORAGE_SWEEP=off)");
  }

  /** Shutdown seam: stop reconnects, tear down sockets, cancel timers, flush buffers. */
  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const ws of this.sockets) ws.terminate();
    this.sockets = [];
    try {
      this.flushActivity();
      this.flushCursor();
    } catch (err) {
      this.log.error({ err }, "final flush failed");
    }
  }

  // ---- full reconcile ------------------------------------------------------

  async fullSync() {
    if (this.syncing) return; // a slow sync must not overlap the next tick
    this.syncing = true;
    try {
      await this.fullSyncInner();
    } finally {
      this.syncing = false;
    }
  }

  private async fullSyncInner() {
    const started = Date.now();
    const repos = await this.pds.listAllRepos();
    const dids = repos.map((r) => r.did);

    const infoBatches = await mapLimit(chunks(dids, 100), FETCH_CONCURRENCY, (batch) =>
      this.pds.accountInfos(batch),
    );
    const infoByDid = new Map(infoBatches.flat().map((i) => [i.did, i]));
    // Only re-read profiles for new accounts and repos whose rev moved: an avatar
    // change is a commit, so an unchanged rev means an unchanged avatar (and the
    // firehose refresh has usually caught it already). Re-reading every profile on
    // every sync costs one getRecord per account per tick on a large PDS.
    const known = new Map(
      (
        this.db.prepare("SELECT did, rev, avatar FROM accounts").all() as {
          did: string;
          rev: string;
          avatar: string | null;
        }[]
      ).map((r) => [r.did, r]),
    );
    const revOf = (repo: RepoEntry) => repo.rev ?? repo.head ?? "";
    const changed = repos
      .filter((repo) => known.get(repo.did)?.rev !== revOf(repo))
      .map((repo) => repo.did);
    const avatarByDid = await this.fetchAvatars(changed);
    const fetched = new Set(changed);

    const upsert = this.db.prepare(`
      INSERT INTO accounts (did, handle, email, indexed_at, status, avatar, rev, updated_at)
      VALUES (@did, @handle, @email, @indexed_at, @status, @avatar, @rev, @updated_at)
      ON CONFLICT(did) DO UPDATE SET
        handle = excluded.handle,
        email = excluded.email,
        indexed_at = excluded.indexed_at,
        status = excluded.status,
        avatar = excluded.avatar,
        rev = excluded.rev,
        updated_at = excluded.updated_at
    `);
    this.db.transaction(() => {
      for (const repo of repos) {
        const info = infoByDid.get(repo.did);
        upsert.run({
          did: repo.did,
          handle: info?.handle ?? "(unknown)",
          email: info?.email ?? null,
          indexed_at: info?.indexedAt ?? "",
          status: repoStatusToAccountStatus(repo),
          avatar: fetched.has(repo.did)
            ? (avatarByDid.get(repo.did) ?? null)
            : (known.get(repo.did)?.avatar ?? null),
          rev: revOf(repo),
          updated_at: Date.now(),
        });
      }
      // drop accounts (and their labels/activity/blob sizes) that no longer exist on the PDS
      this.db.prepare(`DELETE FROM labels WHERE did NOT IN (SELECT did FROM accounts)`).run();
      this.db.prepare(`DELETE FROM activity WHERE did NOT IN (SELECT did FROM accounts)`).run();
      this.db.prepare(`DELETE FROM blob_sizes WHERE did NOT IN (SELECT did FROM accounts)`).run();
      this.db.prepare(`DELETE FROM activity WHERE hour < date('now', '-400 days')`).run();
      if (dids.length > 0) {
        // one JSON-array parameter instead of one bound variable per account: SQLite
        // caps a statement at 32766 variables, which a large PDS exceeds
        this.db
          .prepare(`DELETE FROM accounts WHERE did NOT IN (SELECT value FROM json_each(?))`)
          .run(JSON.stringify(dids));
      }
    })();

    await this.backfillLabels(dids);
    // storage runs detached: a long first sweep must not delay the sync heartbeat
    void this.syncStorage().catch((err) => this.log.error({ err }, "storage sweep failed"));
    setSyncState(this.db, "last_full_sync", new Date().toISOString());
    this.log.info(
      { accounts: repos.length, ms: Date.now() - started },
      "full sync complete",
    );
  }

  /**
   * Measure storage per account: repo CAR bytes plus blob bytes. Repo revs plus a
   * time floor gate the work (only repos that changed since their last measurement,
   * each at most every STORAGE_REMEASURE_MS), and blob sizes are cached per cid
   * since blobs are immutable. First run walks everything; later runs touch only
   * changed repos, so the sweep is cheap enough to run detached on every sync.
   */
  private async syncStorage() {
    if (!STORAGE_SWEEP_ENABLED) return;
    if (this.sweepingStorage) return; // a slow sweep must not overlap the next one
    this.sweepingStorage = true;
    try {
      const stale = this.db
        .prepare(
          `SELECT did, rev FROM accounts
           WHERE (storage_rev IS NULL OR storage_rev != rev)
             AND (storage_at IS NULL OR storage_at < ?)`,
        )
        .all(Date.now() - STORAGE_REMEASURE_MS) as { did: string; rev: string }[];
      if (stale.length === 0) return;
      const started = Date.now();
      await mapLimit(stale, FETCH_CONCURRENCY, async ({ did, rev }) => {
        if (this.stopped) return;
        try {
          const repoBytes = await this.pds.repoCarBytes(did);
          const cids = await this.pds.listBlobCids(did);
          const known = new Map(
            (
              this.db.prepare("SELECT cid, bytes FROM blob_sizes WHERE did = ?").all(did) as {
                cid: string;
                bytes: number;
              }[]
            ).map((r) => [r.cid, r.bytes]),
          );
          const insert = this.db.prepare(
            "INSERT OR REPLACE INTO blob_sizes (did, cid, bytes) VALUES (?, ?, ?)",
          );
          // a listed cid can 404 (blob lost or never imported), so count it as 0
          // and cache the 0 so it isn't refetched every sweep
          const fresh = [...new Set(cids)].filter((cid) => !known.has(cid));
          await mapLimit(fresh, FETCH_CONCURRENCY, async (cid) => {
            const bytes = await this.pds.blobBytes(did, cid).catch(() => 0);
            insert.run(did, cid, bytes);
            known.set(cid, bytes);
          });
          const present = new Set(cids);
          let blobBytes = 0;
          for (const cid of present) blobBytes += known.get(cid) ?? 0;
          const remove = this.db.prepare("DELETE FROM blob_sizes WHERE did = ? AND cid = ?");
          for (const cid of known.keys()) if (!present.has(cid)) remove.run(did, cid);
          this.db
            .prepare(
              `UPDATE accounts SET repo_bytes = ?, blob_bytes = ?, storage_rev = ?, storage_at = ?
               WHERE did = ?`,
            )
            .run(repoBytes, blobBytes, rev, Date.now(), did);
        } catch (err) {
          this.log.warn({ err, did }, "storage measurement failed");
        }
      });
      this.log.info(
        { accounts: stale.length, ms: Date.now() - started },
        "storage sweep complete",
      );
    } finally {
      this.sweepingStorage = false;
    }
  }

  /**
   * Avatar URLs come straight from the PDS: read each account's profile record and
   * point at the blob endpoint. No appview dependency, so it works for accounts the
   * relay never crawled, at the cost of raw blobs instead of CDN-resized thumbnails.
   */
  private async fetchAvatars(dids: string[]): Promise<Map<string, string>> {
    const avatarByDid = new Map<string, string>();
    await mapLimit(dids, FETCH_CONCURRENCY, async (did) => {
      const repo = encodeURIComponent(did);
      try {
        const res = await fetchWithRetry(
          `https://${this.pds.hostname}/xrpc/com.atproto.repo.getRecord?repo=${repo}&collection=app.bsky.actor.profile&rkey=self`,
        );
        if (!res.ok) return; // no profile record, or repo unavailable (e.g. takendown)
        const { value } = (await res.json()) as {
          value?: { avatar?: { ref?: { $link?: string }; cid?: string } };
        };
        // blob refs are {ref: {$link}} in current repos, {cid} in legacy ones
        const cid = value?.avatar?.ref?.$link ?? value?.avatar?.cid;
        if (cid) {
          avatarByDid.set(
            did,
            `https://${this.pds.hostname}/xrpc/com.atproto.sync.getBlob?did=${repo}&cid=${cid}`,
          );
        }
      } catch (err) {
        this.log.warn({ err, did }, "avatar fetch failed");
      }
    });
    return avatarByDid;
  }

  private async backfillLabels(dids: string[]) {
    for (const labeler of this.labelers) {
      const src = labeler.did;
      try {
        const batches = await mapLimit(chunks(dids, 20), FETCH_CONCURRENCY, (batch) =>
          labeler.client.queryLabels(batch),
        );
        const byUri = activeLabels(batches.flat(), src);

        const before = new Set(
          (
            this.db.prepare("SELECT did, val FROM labels WHERE src = ?").all(src) as {
              did: string;
              val: string;
            }[]
          ).map((r) => `${r.did} ${r.val}`),
        );
        this.db.transaction(() => {
          this.db.prepare("DELETE FROM labels WHERE src = ?").run(src);
          const insert = this.db.prepare(
            "INSERT OR REPLACE INTO labels (did, src, val, cts) VALUES (?, ?, ?, ?)",
          );
          for (const [uri, vals] of byUri) {
            for (const [val, cts] of vals) insert.run(uri, src, val, cts);
          }
        })();

        // notify on labels that appeared since the last backfill — but not on the very
        // first sync for a labeler, which would DM every pre-existing flag at once
        const seededKey = `labels_seeded:${src}`;
        if (getSyncState(this.db, seededKey)) {
          for (const [uri, vals] of byUri) {
            const fresh = [...vals.keys()].filter(
              (val) => this.isWatched(labeler, val) && !before.has(`${uri} ${val}`),
            );
            this.notifyNewFlags(uri, fresh, src);
          }
        }
        setSyncState(this.db, seededKey, "1");
      } catch (err) {
        // keep whatever the label stream has written; a failed backfill is not fatal
        this.log.warn({ err, labeler: src }, "label backfill failed");
      }
    }
  }

  // ---- live PDS account stream --------------------------------------------

  private connectAccountStream() {
    if (this.stopped) return;
    const cursor = getSyncState(this.db, ACCOUNT_STREAM_CURSOR_KEY);
    const ws = new WebSocket(accountStreamUrl(this.pds.hostname, cursor));
    this.sockets.push(ws);
    attachHeartbeat(ws);

    ws.on("message", (data: Buffer) => {
      try {
        const { header, body } = readFrame(data);
        if (typeof body?.seq === "number") this.accountCursor = body.seq;
        const did: string | undefined = body?.did ?? body?.repo;
        if (!did) return;
        // #account carries active/status directly; #identity means handle changed;
        // #commit may be a profile update (avatar). All funnel through a dirty refresh.
        if (header?.t === "#account" || header?.t === "#identity" || header?.t === "#commit") {
          this.dirty.add(did);
        }
        if (header?.t === "#commit") {
          // UTC hour buckets; the stats API regroups them into viewer-local days.
          // Bucket by the event's own time so cursor-replayed backfill after downtime
          // lands in the hours it happened, not in a spike at reconnect.
          const eventTime = body.time ? new Date(body.time) : new Date();
          const at = Number.isNaN(eventTime.getTime()) ? new Date() : eventTime;
          const key = `${at.toISOString().slice(0, 13)}|${did}`;
          this.activity.set(key, (this.activity.get(key) ?? 0) + 1);
          if (this.activityAlert && this.notifier) {
            const creates = Array.isArray(body.ops)
              ? body.ops.filter((op: { action?: string }) => op?.action === "create").length
              : 0;
            if (creates > 0) this.trackCreateBurst(did, creates, at.getTime());
          }
        }
      } catch {
        // ignore undecodable frames
      }
    });
    const reconnect = () => {
      this.sockets = this.sockets.filter((s) => s !== ws);
      if (this.stopped) return;
      setTimeout(() => this.connectAccountStream(), RECONNECT_MS).unref();
    };
    ws.once("close", reconnect);
    ws.once("error", (err) => {
      this.log.warn({ err }, "account stream error");
      ws.terminate();
    });
  }

  private async flushDirty() {
    if (this.dirty.size === 0) return;
    const dids = [...this.dirty];
    this.dirty.clear();

    try {
      await this.refreshAccounts(dids);
    } catch (err) {
      // re-queue so the next flush retries; adds, not replaces, so DIDs dirtied mid-flight stay dirty
      for (const did of dids) this.dirty.add(did);
      throw err;
    }
  }

  private async refreshAccounts(dids: string[]) {
    const [infos, avatarByDid, statuses] = await Promise.all([
      mapLimit(chunks(dids, 100), FETCH_CONCURRENCY, (b) => this.pds.accountInfos(b)).then((r) =>
        r.flat(),
      ),
      this.fetchAvatars(dids),
      mapLimit(dids, FETCH_CONCURRENCY, async (did) => {
        try {
          return await this.pds.repoStatus(did);
        } catch {
          return null; // deleted repo — full sync will remove it
        }
      }),
    ]);
    const infoByDid = new Map(infos.map((i) => [i.did, i]));
    const statusByDid = new Map(
      statuses.filter((s): s is RepoEntry => s != null).map((s) => [s.did, s]),
    );

    const upsert = this.db.prepare(`
      INSERT INTO accounts (did, handle, email, indexed_at, status, avatar, rev, updated_at)
      VALUES (@did, @handle, @email, @indexed_at, @status, @avatar, @rev, @updated_at)
      ON CONFLICT(did) DO UPDATE SET
        handle = excluded.handle,
        email = excluded.email,
        indexed_at = excluded.indexed_at,
        status = excluded.status,
        avatar = excluded.avatar,
        rev = excluded.rev,
        updated_at = excluded.updated_at
    `);
    this.db.transaction(() => {
      for (const did of dids) {
        const repo = statusByDid.get(did);
        if (!repo) continue;
        const info = infoByDid.get(did);
        upsert.run({
          did,
          handle: info?.handle ?? "(unknown)",
          email: info?.email ?? null,
          indexed_at: info?.indexedAt ?? "",
          status: repoStatusToAccountStatus(repo),
          avatar: avatarByDid.get(did) ?? null,
          rev: repo.rev ?? repo.head ?? "",
          updated_at: Date.now(),
        });
      }
    })();
    this.log.info({ dids: dids.length }, "refreshed accounts from stream");
  }

  private flushActivity() {
    if (this.activity.size === 0) return;
    const upsert = this.db.prepare(`
      INSERT INTO activity (hour, did, events) VALUES (?, ?, ?)
      ON CONFLICT(hour, did) DO UPDATE SET events = events + excluded.events
    `);
    this.db.transaction(() => {
      for (const [key, n] of this.activity) {
        const [hour, did] = key.split("|");
        upsert.run(hour, did, n);
      }
    })();
    this.activity.clear();
  }

  private flushCursor() {
    if (this.accountCursor == null) return;
    setSyncState(this.db, ACCOUNT_STREAM_CURSOR_KEY, String(this.accountCursor));
    this.accountCursor = null;
  }

  // ---- create-burst alerts -------------------------------------------------

  /**
   * Sliding window of record creations per account, bucketed by minute. Crossing the
   * threshold DMs an alert, at most once per window per account. Buckets key on the
   * event's own time and stale events are ignored outright, so cursor-replayed
   * history after downtime can't fake a burst.
   */
  private trackCreateBurst(did: string, creates: number, eventMs: number) {
    const alert = this.activityAlert!;
    const windowMs = alert.windowMinutes * 60_000;
    const now = Date.now();
    if (eventMs <= now - windowMs) return;
    const cutoff = Math.floor((now - windowMs) / 60_000);
    let buckets = this.createBursts.get(did);
    if (!buckets) {
      buckets = new Map();
      this.createBursts.set(did, buckets);
    }
    const minute = Math.floor(eventMs / 60_000);
    buckets.set(minute, (buckets.get(minute) ?? 0) + creates);
    let total = 0;
    for (const [m, n] of buckets) {
      if (m <= cutoff) buckets.delete(m);
      else total += n;
    }
    if (total < alert.creates) return;
    if (now - (this.burstAlertedAt.get(did) ?? 0) < windowMs) return;
    this.burstAlertedAt.set(did, now);
    const row = this.db.prepare("SELECT handle FROM accounts WHERE did = ?").get(did) as
      | { handle: string }
      | undefined;
    this.log.warn({ did, creates: total }, "record creation burst");
    void this.notifier?.notifyActivitySpike(
      { did, handle: row?.handle ?? did },
      total,
      alert.windowMinutes,
    );
  }

  /** Drop burst state that has aged out of the window, so idle accounts don't linger. */
  private pruneCreateBursts() {
    if (!this.activityAlert) return;
    const windowMs = this.activityAlert.windowMinutes * 60_000;
    const now = Date.now();
    const cutoff = Math.floor((now - windowMs) / 60_000);
    for (const [did, buckets] of this.createBursts) {
      for (const m of buckets.keys()) if (m <= cutoff) buckets.delete(m);
      if (buckets.size === 0) this.createBursts.delete(did);
    }
    for (const [did, at] of this.burstAlertedAt) {
      if (now - at >= windowMs) this.burstAlertedAt.delete(did);
    }
  }

  // ---- live label streams --------------------------------------------------

  private connectLabelStream(labeler: WatchedLabeler) {
    if (this.stopped) return;
    const cursorKey = `labeler_cursor:${labeler.did}`;
    void labeler.client
      .resolveEndpoint()
      .then((endpoint) => {
        const cursor = getSyncState(this.db, cursorKey);
        const url =
          endpoint.replace(/^http/, "ws") +
          "/xrpc/com.atproto.label.subscribeLabels" +
          (cursor ? `?cursor=${cursor}` : "");
        const ws = new WebSocket(url);
        this.sockets.push(ws);
        attachHeartbeat(ws);

        ws.on("message", (data: Buffer) => {
          try {
            const { header, body } = readFrame(data);
            if (header?.t !== "#labels" || !body) return;
            this.applyLabelEvents(labeler, body.labels ?? []);
            if (typeof body.seq === "number") {
              setSyncState(this.db, cursorKey, String(body.seq));
            }
          } catch {
            // ignore undecodable frames
          }
        });
        const reconnect = () => {
          this.sockets = this.sockets.filter((s) => s !== ws);
          if (this.stopped) return;
          setTimeout(() => this.connectLabelStream(labeler), RECONNECT_MS).unref();
        };
        ws.once("close", reconnect);
        ws.once("error", (err) => {
          this.log.warn({ err, labeler: labeler.did }, "label stream error");
          ws.terminate();
        });
      })
      .catch((err) => {
        this.log.warn({ err, labeler: labeler.did }, "label stream connect failed");
        if (!this.stopped) {
          setTimeout(() => this.connectLabelStream(labeler), RECONNECT_MS).unref();
        }
      });
  }

  private applyLabelEvents(labeler: WatchedLabeler, labels: Label[]) {
    const isOurAccount = this.db.prepare("SELECT 1 FROM accounts WHERE did = ?");
    const exists = this.db.prepare("SELECT 1 FROM labels WHERE did = ? AND src = ? AND val = ?");
    const insert = this.db.prepare(
      "INSERT OR REPLACE INTO labels (did, src, val, cts) VALUES (?, ?, ?, ?)",
    );
    const remove = this.db.prepare("DELETE FROM labels WHERE did = ? AND src = ? AND val = ?");
    const freshByDid = new Map<string, string[]>();
    for (const label of labels) {
      if (label.src !== labeler.did) continue;
      if (!label.uri.startsWith("did:")) continue; // only account-level labels
      if (!isOurAccount.get(label.uri)) continue;
      if (label.neg) {
        remove.run(label.uri, labeler.did, label.val);
        continue;
      }
      const isNew = !exists.get(label.uri, labeler.did, label.val);
      insert.run(label.uri, labeler.did, label.val, label.cts);
      if (isNew && this.isWatched(labeler, label.val)) {
        freshByDid.set(label.uri, [...(freshByDid.get(label.uri) ?? []), label.val]);
      }
    }
    for (const [did, vals] of freshByDid) this.notifyNewFlags(did, vals, labeler.did);
  }
}

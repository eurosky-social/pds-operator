import WebSocket from "ws";
import type { FastifyBaseLogger } from "fastify";
import { readFrame, type PdsClient, type RepoEntry } from "./pdsClient.js";
import { activeLabels, type Label, type WatchedLabeler } from "./labelerClient.js";
import { setSyncState, getSyncState, type Db } from "./db.js";
import type { BskyDmNotifier } from "./notifier.js";

const FULL_SYNC_INTERVAL_MS = 15 * 60 * 1000;
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

  constructor(
    private db: Db,
    private pds: PdsClient,
    private labelers: WatchedLabeler[],
    private log: FastifyBaseLogger,
    private notifier: BskyDmNotifier | null = null,
    private labelNames: Map<string, Map<string, string>> = new Map(),
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
    setInterval(() => {
      void this.fullSync().catch((err) => this.log.error({ err }, "full sync failed"));
    }, FULL_SYNC_INTERVAL_MS).unref();
    setInterval(() => {
      void this.flushDirty().catch((err) => this.log.error({ err }, "dirty flush failed"));
      try {
        this.flushActivity();
      } catch (err) {
        this.log.error({ err }, "activity flush failed");
      }
    }, DIRTY_FLUSH_MS).unref();

    this.connectAccountStream();
    for (const labeler of this.labelers) this.connectLabelStream(labeler);
  }

  // ---- full reconcile ------------------------------------------------------

  async fullSync() {
    const started = Date.now();
    const repos = await this.pds.listAllRepos();
    const dids = repos.map((r) => r.did);

    const infoBatches = await mapLimit(chunks(dids, 100), FETCH_CONCURRENCY, (batch) =>
      this.pds.accountInfos(batch),
    );
    const infoByDid = new Map(infoBatches.flat().map((i) => [i.did, i]));
    const avatarByDid = await this.fetchAvatars(dids);

    const upsert = this.db.prepare(`
      INSERT INTO accounts (did, handle, email, indexed_at, status, avatar, updated_at)
      VALUES (@did, @handle, @email, @indexed_at, @status, @avatar, @updated_at)
      ON CONFLICT(did) DO UPDATE SET
        handle = excluded.handle,
        email = excluded.email,
        indexed_at = excluded.indexed_at,
        status = excluded.status,
        avatar = excluded.avatar,
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
          avatar: avatarByDid.get(repo.did) ?? null,
          updated_at: Date.now(),
        });
      }
      // drop accounts (and their labels/activity) that no longer exist on the PDS
      const params = dids.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM labels WHERE did NOT IN (SELECT did FROM accounts)`).run();
      this.db.prepare(`DELETE FROM activity WHERE did NOT IN (SELECT did FROM accounts)`).run();
      this.db.prepare(`DELETE FROM activity WHERE hour < date('now', '-400 days')`).run();
      if (dids.length > 0) {
        this.db.prepare(`DELETE FROM accounts WHERE did NOT IN (${params})`).run(...dids);
      }
    })();

    await this.backfillLabels(dids);
    setSyncState(this.db, "last_full_sync", new Date().toISOString());
    this.log.info(
      { accounts: repos.length, ms: Date.now() - started },
      "full sync complete",
    );
  }

  private async fetchAvatars(dids: string[]): Promise<Map<string, string>> {
    const avatarByDid = new Map<string, string>();
    await mapLimit(chunks(dids, 25), FETCH_CONCURRENCY, async (batch) => {
      const params = new URLSearchParams();
      for (const did of batch) params.append("actors", did);
      try {
        const res = await fetchWithRetry(
          `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?${params}`,
        );
        if (!res.ok) return;
        const { profiles } = (await res.json()) as { profiles: { did: string; avatar?: string }[] };
        for (const p of profiles) if (p.avatar) avatarByDid.set(p.did, p.avatar);
      } catch (err) {
        this.log.warn({ err }, "avatar batch failed");
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
        if (typeof body?.seq === "number") {
          setSyncState(this.db, ACCOUNT_STREAM_CURSOR_KEY, String(body.seq));
        }
        const did: string | undefined = body?.did ?? body?.repo;
        if (!did) return;
        // #account carries active/status directly; #identity means handle changed;
        // #commit may be a profile update (avatar). All funnel through a dirty refresh.
        if (header?.t === "#account" || header?.t === "#identity" || header?.t === "#commit") {
          this.dirty.add(did);
        }
        if (header?.t === "#commit") {
          // UTC hour buckets; the stats API regroups them into viewer-local days
          const key = `${new Date().toISOString().slice(0, 13)}|${did}`;
          this.activity.set(key, (this.activity.get(key) ?? 0) + 1);
        }
      } catch {
        // ignore undecodable frames
      }
    });
    const reconnect = () => {
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
      INSERT INTO accounts (did, handle, email, indexed_at, status, avatar, updated_at)
      VALUES (@did, @handle, @email, @indexed_at, @status, @avatar, @updated_at)
      ON CONFLICT(did) DO UPDATE SET
        handle = excluded.handle,
        email = excluded.email,
        indexed_at = excluded.indexed_at,
        status = excluded.status,
        avatar = excluded.avatar,
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

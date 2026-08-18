import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyBaseLogger } from "fastify";
import { Syncer, accountStreamUrl } from "../src/sync.js";
import { openDb, setSyncState, getSyncState } from "../src/db.js";
import type { PdsClient } from "../src/pdsClient.js";
import type { BskyDmNotifier } from "../src/notifier.js";

const stubLogger = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

function burstSyncer(threshold: number) {
  const calls: { did: string; creates: number; windowMinutes: number }[] = [];
  const notifier = {
    notifyActivitySpike: (account: { did: string }, creates: number, windowMinutes: number) => {
      calls.push({ did: account.did, creates, windowMinutes });
      return Promise.resolve();
    },
  } as unknown as BskyDmNotifier;
  const syncer = new Syncer(
    openDb(":memory:"),
    { hostname: "pds.test" } as unknown as PdsClient,
    [],
    stubLogger,
    notifier,
    new Map(),
    { creates: threshold, windowMinutes: 60 },
  );
  return { syncer: syncer as any, calls };
}

test("flushDirty re-queues dids when the flush fails", async () => {
  const pds = {
    hostname: "pds.test",
    accountInfos: async () => {
      throw new Error("pds down");
    },
    repoStatus: async () => {
      throw new Error("pds down");
    },
  } as unknown as PdsClient;
  const syncer = new Syncer(openDb(":memory:"), pds, [], stubLogger);
  (syncer as any).fetchAvatars = async () => new Map(); // no network in tests

  (syncer as any).dirty.add("did:plc:x");
  await assert.rejects(() => (syncer as any).flushDirty(), /pds down/);
  assert.ok((syncer as any).dirty.has("did:plc:x"), "failed flush must keep the did dirty");
});

test("fullSync is single-flight", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const pds = {
    hostname: "pds.test",
    listAllRepos: async () => {
      calls++;
      await gate;
      return [];
    },
    accountInfos: async () => [],
  } as unknown as PdsClient;
  const syncer = new Syncer(openDb(":memory:"), pds, [], stubLogger);
  (syncer as any).fetchAvatars = async () => new Map();

  const first = syncer.fullSync();
  const second = syncer.fullSync(); // overlapping tick — must be a no-op
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("account cursor persists on flush, not per frame", () => {
  const db = openDb(":memory:");
  const syncer = new Syncer(db, { hostname: "pds.test" } as unknown as PdsClient, [], stubLogger);
  (syncer as any).accountCursor = 99;
  assert.equal(getSyncState(db, "account_stream_cursor"), null);
  (syncer as any).flushCursor();
  assert.equal(getSyncState(db, "account_stream_cursor"), "99");
});

test("create burst alerts once when the threshold is crossed", () => {
  const { syncer, calls } = burstSyncer(5);
  const now = Date.now();
  syncer.trackCreateBurst("did:plc:spam", 3, now);
  assert.equal(calls.length, 0, "below threshold must not alert");
  syncer.trackCreateBurst("did:plc:spam", 3, now);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].creates, 6);
  assert.equal(calls[0].windowMinutes, 60);
  // still inside the window: more creates must not re-alert
  syncer.trackCreateBurst("did:plc:spam", 50, now);
  assert.equal(calls.length, 1, "one alert per account per window");
  // a different account keeps its own counter
  syncer.trackCreateBurst("did:plc:other", 2, now);
  assert.equal(calls.length, 1);
});

test("create bursts ignore replayed history and age out", () => {
  const { syncer, calls } = burstSyncer(5);
  const now = Date.now();
  // events older than the window (e.g. cursor replay after downtime) don't count
  syncer.trackCreateBurst("did:plc:x", 100, now - 61 * 60_000);
  assert.equal(calls.length, 0);
  assert.equal(syncer.createBursts.size, 0);
  // in-window creates below threshold stay buffered, then prune drops aged buckets
  syncer.trackCreateBurst("did:plc:x", 3, now - 30 * 60_000);
  assert.equal(syncer.createBursts.size, 1);
  syncer.pruneCreateBursts();
  assert.equal(syncer.createBursts.size, 1, "in-window buckets survive the prune");
  for (const buckets of syncer.createBursts.values()) {
    for (const m of [...buckets.keys()]) {
      buckets.set(m - 61, buckets.get(m));
      buckets.delete(m);
    }
  }
  syncer.pruneCreateBursts();
  assert.equal(syncer.createBursts.size, 0, "aged buckets are dropped");
});

test("account stream url resumes from the persisted cursor", () => {
  const db = openDb(":memory:");
  assert.equal(
    accountStreamUrl("pds.test", getSyncState(db, "account_stream_cursor")),
    "wss://pds.test/xrpc/com.atproto.sync.subscribeRepos",
  );
  setSyncState(db, "account_stream_cursor", "42");
  assert.equal(
    accountStreamUrl("pds.test", getSyncState(db, "account_stream_cursor")),
    "wss://pds.test/xrpc/com.atproto.sync.subscribeRepos?cursor=42",
  );
});

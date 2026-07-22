import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyBaseLogger } from "fastify";
import { Syncer, accountStreamUrl } from "./sync.js";
import { openDb, setSyncState, getSyncState } from "./db.js";
import type { PdsClient } from "./pdsClient.js";

const stubLogger = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

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

import { test } from "node:test";
import assert from "node:assert/strict";
import type { FastifyBaseLogger } from "fastify";
import { PurgeRunner } from "../src/purge.js";
import { openDb } from "../src/db.js";
import type { PdsClient } from "../src/pdsClient.js";

const stubLogger = { info() {}, warn() {}, error() {} } as unknown as FastifyBaseLogger;

/** A fake PDS whose repo empties `chunk` records per round; records the takedown timeline. */
function fakePds(total: number, chunk: number) {
  let remaining = total;
  const takedowns: boolean[] = [];
  const pds = {
    async setAccountTakedown(_did: string, takedown: boolean) {
      takedowns.push(takedown);
    },
    async setAccountTakedownStubborn(_did: string, takedown: boolean) {
      takedowns.push(takedown);
    },
    async signInAsAccount() {
      return "jwt";
    },
    async deleteRecordsChunk() {
      const n = Math.min(chunk, remaining);
      remaining -= n;
      return { deleted: n, done: remaining === 0 };
    },
  } as unknown as PdsClient;
  return { pds, takedowns, remaining: () => remaining };
}

const settle = async (predicate: () => boolean, ms = 2000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
};

test("purge deletes across rounds and finishes taken down", async () => {
  const db = openDb(":memory:");
  const { pds, takedowns, remaining } = fakePds(1200, 500);
  const runner = new PurgeRunner(db, pds, stubLogger);
  // shrink the pauses so the test runs fast
  (runner as any).sleep = () => Promise.resolve();

  runner.enqueue("did:plc:spam", "brooke");
  await settle(() => runner.get("did:plc:spam")?.status === "done");

  const job = runner.get("did:plc:spam")!;
  assert.equal(job.deleted, 1200);
  assert.equal(job.enabled, 0, "account must end taken down");
  assert.equal(remaining(), 0);
  // last takedown call must be a re-takedown (true), never left enabled
  assert.equal(takedowns.at(-1), true);
  runner.stop();
});

test("a purge job persists progress in the db", async () => {
  const db = openDb(":memory:");
  const { pds } = fakePds(500, 500);
  const runner = new PurgeRunner(db, pds, stubLogger);
  (runner as any).sleep = () => Promise.resolve();
  runner.enqueue("did:plc:x", "op");
  await settle(() => runner.get("did:plc:x")?.status === "done");
  const row = db.prepare("SELECT status, deleted FROM purge_jobs WHERE did = ?").get("did:plc:x");
  assert.deepEqual(row, { status: "done", deleted: 500 });
  runner.stop();
});

test("reconciler re-takes-down an account a crash left enabled", async () => {
  const db = openDb(":memory:");
  const { pds, takedowns } = fakePds(0, 500);
  // simulate a crash mid-round: a job row flagged enabled with no active runner
  db.prepare(
    "INSERT INTO purge_jobs (did, status, deleted, enabled, operator, created_at, updated_at) VALUES (?, 'running', 0, 1, 'op', ?, ?)",
  ).run("did:plc:stuck", Date.now(), Date.now());
  const runner = new PurgeRunner(db, pds, stubLogger);
  await (runner as any).reconcileEnabled();
  assert.equal(takedowns.at(-1), true, "reconciler restores the takedown");
  const row = db.prepare("SELECT enabled FROM purge_jobs WHERE did = ?").get("did:plc:stuck") as {
    enabled: number;
  };
  assert.equal(row.enabled, 0, "enabled flag cleared once confirmed");
  runner.stop();
});

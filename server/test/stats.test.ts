import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { openDb } from "../src/db.js";
import { registerStatsRoutes } from "../src/routes/stats.js";
import type { PdsClient } from "../src/pdsClient.js";

async function statsApp() {
  const db = openDb(":memory:");
  const app = Fastify();
  app.decorateRequest("session", null as any);
  app.addHook("onRequest", async (req) => {
    (req as any).session = { operator: "test" };
  });
  registerStatsRoutes(app, {} as PdsClient, db, []);
  return { app, db };
}

test("stats buckets signups and daily writers in the viewer's half-hour timezone", async () => {
  const { app, db } = await statsApp();
  const tz = "Asia/Kolkata"; // UTC+05:30, no DST
  const offset = 5.5 * 3_600_000;
  const now = Date.now();
  const [y, m] = new Date(now + offset).toISOString().slice(0, 7).split("-").map(Number);
  // the instant the current local month began, as UTC
  const monthStart = Date.UTC(y, m - 1, 1) - offset;
  const thisMonth = `${y}-${String(m).padStart(2, "0")}`;
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;

  const account = db.prepare(
    "INSERT INTO accounts (did, handle, indexed_at, status, updated_at) VALUES (?, ?, ?, ?, 0)",
  );
  // one minute either side of local midnight: same UTC hour, different local months
  account.run("did:plc:a", "a", new Date(monthStart - 60_000).toISOString(), "active");
  account.run("did:plc:b", "b", new Date(monthStart + 60_000).toISOString(), "active");
  account.run("did:plc:c", "c", new Date(monthStart + 120_000).toISOString(), "takendown");
  account.run("did:plc:d", "d", "", "active");

  const activity = db.prepare("INSERT INTO activity (hour, did, events) VALUES (?, ?, ?)");
  const hour = (t: number) => new Date(t).toISOString().slice(0, 13);
  const yesterday = now - 86_400_000;
  activity.run(hour(yesterday), "did:plc:a", 3);
  activity.run(hour(yesterday - 3_600_000), "did:plc:a", 2);
  activity.run(hour(yesterday), "did:plc:b", 1);
  activity.run(hour(yesterday), "did:plc:c", 50); // taken down: not active, not top

  const res = await app.inject(
    `/api/stats?days=7&months=6&activeDays=7&tz=${encodeURIComponent(tz)}`,
  );
  assert.equal(res.statusCode, 200);
  const body = res.json();

  const signups = new Map(body.signups.map((s: { month: string; n: number }) => [s.month, s.n]));
  assert.equal(signups.get(prev), 1);
  assert.equal(signups.get(thisMonth), 2);

  assert.equal(body.activity.active, 2);
  assert.equal(body.activity.dormant, 1);
  assert.deepEqual(
    body.activity.topAccounts.map((a: { did: string; n: number }) => [a.did, a.n]),
    [
      ["did:plc:a", 5],
      ["did:plc:b", 1],
    ],
  );
  assert.ok(body.activity.avgDailyActive > 0);
  assert.equal(body.activity.writes, 56);
});

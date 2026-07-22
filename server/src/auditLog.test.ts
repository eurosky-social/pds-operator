import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("readRecent skips a torn trailing line", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "audit-"));
  const logPath = path.join(dir, "audit.log");
  await writeFile(
    logPath,
    JSON.stringify({ at: "2026-01-01T00:00:00Z", operator: "op", action: "a" }) +
      "\n" +
      JSON.stringify({ at: "2026-01-02T00:00:00Z", operator: "op", action: "b" }) +
      '\n{"at":"2026-', // crash mid-append
  );
  // the module resolves AUDIT_LOG_PATH at import time
  process.env.AUDIT_LOG_PATH = logPath;
  const { readRecent } = await import("./auditLog.js");

  const entries = await readRecent();
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map((e) => e.action),
    ["b", "a"], // newest first
  );
  await rm(dir, { recursive: true, force: true });
});

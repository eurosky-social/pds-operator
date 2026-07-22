import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AuditEntry {
  at: string;
  operator: string;
  action: string;
  target?: string;
}

// anchored to the server directory, not the process working directory
const LOG_PATH =
  process.env.AUDIT_LOG_PATH ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../audit.log");

export async function recordAction(entry: Omit<AuditEntry, "at">) {
  const full: AuditEntry = { at: new Date().toISOString(), ...entry };
  await appendFile(LOG_PATH, JSON.stringify(full) + "\n");
  return full;
}

export async function readRecent(limit = 50): Promise<AuditEntry[]> {
  const raw = await readFile(LOG_PATH, "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as AuditEntry;
      } catch {
        return null; // torn line from a crash mid-append — skip, don't 500
      }
    })
    .filter((e): e is AuditEntry => e !== null)
    .reverse();
}

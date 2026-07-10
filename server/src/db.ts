import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

export interface AccountRow {
  did: string;
  handle: string;
  email: string | null;
  indexed_at: string;
  status: "active" | "takendown" | "deactivated";
  avatar: string | null;
}

export interface LabelRow {
  did: string;
  src: string;
  val: string;
  cts: string;
}

export function openDb(file?: string) {
  const dbPath =
    file ??
    process.env.DB_PATH ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../data.sqlite");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      did TEXT PRIMARY KEY,
      handle TEXT NOT NULL DEFAULT '(unknown)',
      email TEXT,
      indexed_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      avatar TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS accounts_indexed_at ON accounts(indexed_at DESC);

    CREATE TABLE IF NOT EXISTS labels (
      did TEXT NOT NULL,
      src TEXT NOT NULL,
      val TEXT NOT NULL,
      cts TEXT NOT NULL,
      PRIMARY KEY (did, src, val)
    );
    CREATE INDEX IF NOT EXISTS labels_did ON labels(did);

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL,
      transports TEXT,
      name TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS enroll_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);
  return db;
}

export type Db = ReturnType<typeof openDb>;

export function getSyncState(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSyncState(db: Db, key: string, value: string) {
  db.prepare(
    "INSERT INTO sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

// ---- one-time passkey enrollment tokens (minted by the CLI, hashed at rest) ----

const ENROLL_TOKEN_TTL_MS = 15 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createEnrollToken(db: Db): { token: string; expiresAt: number } {
  db.prepare("DELETE FROM enroll_tokens WHERE expires_at <= ?").run(Date.now());
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + ENROLL_TOKEN_TTL_MS;
  db.prepare("INSERT INTO enroll_tokens (token_hash, expires_at) VALUES (?, ?)").run(
    hashToken(token),
    expiresAt,
  );
  return { token, expiresAt };
}

export function checkEnrollToken(db: Db, token: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM enroll_tokens WHERE token_hash = ? AND expires_at > ?")
    .get(hashToken(token), Date.now());
  return Boolean(row);
}

export function consumeEnrollToken(db: Db, token: string): boolean {
  const res = db
    .prepare("DELETE FROM enroll_tokens WHERE token_hash = ? AND expires_at > ?")
    .run(hashToken(token), Date.now());
  return res.changes > 0;
}

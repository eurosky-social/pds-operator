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
  rev: string;
  repo_bytes: number | null;
  blob_bytes: number | null;
  storage_rev: string | null;
  storage_at: number | null;
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

    -- per-account commit counts from the firehose, bucketed by UTC hour ("YYYY-MM-DDTHH")
    -- so the stats API can regroup them into days in the viewer's timezone. Unlike the
    -- rest of this file, activity is NOT rebuildable from the PDS — counting starts when
    -- the server first runs and history is lost if the file is deleted.
    CREATE TABLE IF NOT EXISTS activity (
      hour TEXT NOT NULL,
      did TEXT NOT NULL,
      events INTEGER NOT NULL,
      PRIMARY KEY (hour, did)
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- per-blob sizes, fetched once per cid (blobs are immutable) so the storage
    -- sweep only pays for new blobs
    CREATE TABLE IF NOT EXISTS blob_sizes (
      did TEXT NOT NULL,
      cid TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      PRIMARY KEY (did, cid)
    );

    CREATE TABLE IF NOT EXISTS passkeys (
      id TEXT PRIMARY KEY,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL,
      transports TEXT,
      name TEXT,
      created_at INTEGER NOT NULL
    );

    -- named admins, keyed by their atproto DID. enrolled_at is set once they have
    -- proven the DID via OAuth and created their passkey; null means invited only
    CREATE TABLE IF NOT EXISTS operators (
      did TEXT PRIMARY KEY,
      handle TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      enrolled_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS enroll_tokens (
      token_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );

    -- record-purge jobs run in the background, one at a time, deleting a taken-down
    -- account's records in paced rounds. 'enabled' is the safety flag: 1 whenever the
    -- account is (or might be) lifted out of takedown, so a reconciler can force it
    -- back down after a crash. The account survives; only its records are deleted.
    CREATE TABLE IF NOT EXISTS purge_jobs (
      did TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'pending',
      deleted INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      operator TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  const addColumn = (table: string, name: string, ddl: string) => {
    const has = db
      .prepare(`SELECT COUNT(*) AS n FROM pragma_table_info('${table}') WHERE name = ?`)
      .get(name) as { n: number };
    if (has.n === 0) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  // storage columns: rev tracks the repo head and storage_at the last measurement,
  // so the sweep only re-measures changed repos, at most so often
  addColumn("accounts", "rev", "rev TEXT NOT NULL DEFAULT ''");
  addColumn("accounts", "repo_bytes", "repo_bytes INTEGER");
  addColumn("accounts", "blob_bytes", "blob_bytes INTEGER");
  addColumn("accounts", "storage_rev", "storage_rev TEXT");
  addColumn("accounts", "storage_at", "storage_at INTEGER");
  // passkeys enrolled through the admin OAuth flow belong to a named operator;
  // legacy CLI-enrolled passkeys keep a null owner and sign in as "operator"
  addColumn("passkeys", "operator_did", "operator_did TEXT");
  // enroll tokens minted by the OAuth callback carry the verified DID, so the
  // enrollment can hop from the 127.0.0.1 callback origin back to the dashboard
  // origin without relying on a session cookie
  addColumn("enroll_tokens", "operator_did", "operator_did TEXT");

  // activity was briefly bucketed by whole day; re-home those rows at UTC midnight
  const legacyDayColumn = db
    .prepare("SELECT COUNT(*) AS n FROM pragma_table_info('activity') WHERE name = 'day'")
    .get() as { n: number };
  if (legacyDayColumn.n > 0) {
    db.exec(`
      ALTER TABLE activity RENAME TO activity_legacy;
      CREATE TABLE activity (
        hour TEXT NOT NULL,
        did TEXT NOT NULL,
        events INTEGER NOT NULL,
        PRIMARY KEY (hour, did)
      );
      INSERT INTO activity (hour, did, events)
        SELECT day || 'T00', did, events FROM activity_legacy;
      DROP TABLE activity_legacy;
    `);
  }
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

export function createEnrollToken(
  db: Db,
  operatorDid: string | null = null,
): { token: string; expiresAt: number } {
  db.prepare("DELETE FROM enroll_tokens WHERE expires_at <= ?").run(Date.now());
  const token = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + ENROLL_TOKEN_TTL_MS;
  db.prepare(
    "INSERT INTO enroll_tokens (token_hash, expires_at, operator_did) VALUES (?, ?, ?)",
  ).run(hashToken(token), expiresAt, operatorDid);
  return { token, expiresAt };
}

/** Valid-token lookup without consuming it. */
export function peekEnrollToken(db: Db, token: string): { operatorDid: string | null } | null {
  const row = db
    .prepare("SELECT operator_did FROM enroll_tokens WHERE token_hash = ? AND expires_at > ?")
    .get(hashToken(token), Date.now()) as { operator_did: string | null } | undefined;
  return row ? { operatorDid: row.operator_did } : null;
}

export function checkEnrollToken(db: Db, token: string): boolean {
  return peekEnrollToken(db, token) != null;
}

export function consumeEnrollToken(db: Db, token: string): { operatorDid: string | null } | null {
  const found = peekEnrollToken(db, token);
  if (!found) return null;
  db.prepare("DELETE FROM enroll_tokens WHERE token_hash = ?").run(hashToken(token));
  return found;
}

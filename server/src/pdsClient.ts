import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { decodeMultiple } from "cbor-x";

export interface RepoEntry {
  did: string;
  active?: boolean;
  status?: string;
}

export interface AccountInfo {
  did: string;
  handle: string;
  email?: string;
  indexedAt: string;
}

export interface InviteCode {
  code: string;
  available: number;
  disabled: boolean;
  forAccount: string;
  createdBy: string;
  createdAt: string;
  uses: { usedBy: string; usedAt: string }[];
}

export interface AdminAccount {
  did: string;
  handle: string;
  email?: string;
  indexedAt: string;
  status?: "active" | "takendown" | "deactivated";
  avatar?: string;
  labels?: string[];
}

export class PdsClient {
  private accessJwt: string | null = null;
  private refreshJwt: string | null = null;
  private sessionPromise: Promise<void> | null = null;

  constructor(
    public readonly hostname: string,
    private adminPassword: string,
    /**
     * When set, admin calls sign in as this account (which must have admin rights on the
     * PDS) and send bearer tokens instead of `admin:<password>` basic auth. Needed for
     * PDS implementations without an admin password, e.g. tranquil-pds. adminPassword is
     * then this account's password — an app password works and sidesteps 2FA.
     */
    private adminIdentifier?: string,
  ) {}

  private async createSession(): Promise<void> {
    const res = await fetch(`https://${this.hostname}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: this.adminIdentifier, password: this.adminPassword }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PDS admin sign-in as ${this.adminIdentifier} failed: ${res.status} ${body}`);
    }
    const { accessJwt, refreshJwt } = (await res.json()) as {
      accessJwt: string;
      refreshJwt: string;
    };
    this.accessJwt = accessJwt;
    this.refreshJwt = refreshJwt;
  }

  private async updateSession(update: () => Promise<void>): Promise<void> {
    let promise = this.sessionPromise;
    if (!promise) {
      promise = update();
      this.sessionPromise = promise;
    }
    try {
      await promise;
    } finally {
      if (this.sessionPromise === promise) this.sessionPromise = null;
    }
  }

  private async ensureSession(): Promise<string> {
    if (!this.accessJwt) await this.updateSession(() => this.createSession());
    return this.accessJwt!;
  }

  private async refreshSession(): Promise<boolean> {
    if (!this.refreshJwt) return false;
    const res = await fetch(`https://${this.hostname}/xrpc/com.atproto.server.refreshSession`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.refreshJwt}` },
    });
    if (res.status === 400 || res.status === 401) return false;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PDS admin session refresh failed: ${res.status} ${body}`);
    }
    const { accessJwt, refreshJwt } = (await res.json()) as {
      accessJwt: string;
      refreshJwt: string;
    };
    this.accessJwt = accessJwt;
    this.refreshJwt = refreshJwt;
    return true;
  }

  private async renewSession(expiredAccessJwt: string): Promise<void> {
    if (this.accessJwt !== expiredAccessJwt) return;
    await this.updateSession(async () => {
      if (this.accessJwt !== expiredAccessJwt) return;
      if (await this.refreshSession()) return;
      this.accessJwt = null;
      this.refreshJwt = null;
      await this.createSession();
    });
  }

  private async xrpc(path: string, opts: RequestInit = {}, retry = true): Promise<any> {
    const accessJwt = this.adminIdentifier ? await this.ensureSession() : null;
    const authorization = accessJwt
      ? `Bearer ${accessJwt}`
      : `Basic ${Buffer.from(`admin:${this.adminPassword}`).toString("base64")}`;
    const res = await fetch(`https://${this.hostname}/xrpc/${path}`, {
      ...opts,
      headers: {
        ...opts.headers,
        Authorization: authorization,
        "Content-Type": "application/json",
      },
    });
    if (res.status === 401 && this.adminIdentifier && retry) {
      await this.renewSession(accessJwt!);
      return this.xrpc(path, opts, false);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`PDS ${path} failed: ${res.status} ${body}`);
    }
    // some procedures (e.g. disableInviteCodes) return 200 with an empty body
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  async listRepos(cursor?: string, limit = 500): Promise<{ repos: RepoEntry[]; cursor?: string }> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    return this.xrpc(`com.atproto.sync.listRepos?${params}`) as Promise<{
      repos: RepoEntry[];
      cursor?: string;
    }>;
  }

  async listAllRepos(): Promise<RepoEntry[]> {
    const repos: RepoEntry[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.listRepos(cursor);
      repos.push(...page.repos);
      cursor = page.repos.length > 0 ? page.cursor : undefined;
    } while (cursor);
    return repos;
  }

  /** Admin account info (handle/email/indexedAt); `dids` capped at 100 per call by the PDS. */
  async accountInfos(dids: string[]): Promise<AccountInfo[]> {
    if (dids.length === 0) return [];
    const params = new URLSearchParams();
    for (const did of dids) params.append("dids", did);
    const { infos } = (await this.xrpc(`com.atproto.admin.getAccountInfos?${params}`)) as {
      infos: AccountInfo[];
    };
    return infos;
  }

  async repoStatus(did: string): Promise<RepoEntry> {
    return this.xrpc(
      `com.atproto.sync.getRepoStatus?did=${encodeURIComponent(did)}`,
    ) as Promise<RepoEntry>;
  }

  async getAccount(did: string): Promise<AdminAccount> {
    return this.xrpc(`com.atproto.admin.getAccountInfo?did=${encodeURIComponent(did)}`);
  }

  async setAccountTakedown(did: string, takedown: boolean) {
    return this.xrpc("com.atproto.admin.updateSubjectStatus", {
      method: "POST",
      body: JSON.stringify({
        subject: { $type: "com.atproto.admin.defs#repoRef", did },
        takedown: takedown ? { applied: true } : { applied: false },
      }),
    });
  }

  async getInviteCodes(limit = 100): Promise<{ codes: InviteCode[] }> {
    return this.xrpc(`com.atproto.admin.getInviteCodes?sort=recent&limit=${limit}`) as Promise<{
      codes: InviteCode[];
    }>;
  }

  async createInviteCode(useCount = 1): Promise<{ code: string }> {
    return this.xrpc("com.atproto.server.createInviteCode", {
      method: "POST",
      body: JSON.stringify({ useCount }),
    }) as Promise<{ code: string }>;
  }

  async disableInviteCodes(codes: string[]) {
    return this.xrpc("com.atproto.admin.disableInviteCodes", {
      method: "POST",
      body: JSON.stringify({ codes }),
    });
  }

  async resetAccountPassword(did: string): Promise<{ password: string }> {
    const password = randomBytes(16).toString("base64url");
    await this.xrpc("com.atproto.admin.updateAccountPassword", {
      method: "POST",
      body: JSON.stringify({ did, password }),
    });
    return { password };
  }

  /**
   * No public "current max seq" endpoint exists on the PDS. Approximate by opening a
   * subscribeRepos socket starting at `fromSeq` (e.g. the relay's last-known seq) so the
   * server immediately sends buffered backfill frames rather than waiting on live traffic,
   * and taking the highest seq seen within the read window. When there's a large backlog
   * this returns "how far it got in windowMs," not necessarily the true live head — still
   * far more useful than an unbounded wait for the next real-time event.
   */
  async approximateHeadSeq(fromSeq: number, windowMs = 3000): Promise<number | null> {
    return new Promise((resolve) => {
      const ws = new WebSocket(
        `wss://${this.hostname}/xrpc/com.atproto.sync.subscribeRepos?cursor=${fromSeq}`,
      );
      let maxSeq: number | null = null;
      let opened = false;

      const finish = () => {
        clearTimeout(timer);
        ws.terminate();
        // Socket opened but no frames arrived: the PDS has nothing past fromSeq, so the
        // head is (at least) fromSeq — report "caught up" rather than "unknown".
        resolve(maxSeq ?? (opened ? fromSeq : null));
      };
      const timer = setTimeout(finish, windowMs);

      ws.once("open", () => {
        opened = true;
      });
      ws.on("message", (data: Buffer) => {
        const frame = readFrame(data);
        if (typeof frame.body?.seq === "number") {
          maxSeq = maxSeq == null ? frame.body.seq : Math.max(maxSeq, frame.body.seq);
        }
      });

      ws.once("error", finish);
    });
  }
}

/**
 * Each event-stream frame is two concatenated CBOR values: a header ({op, t}) then a body.
 * Shared by subscribeRepos and subscribeLabels consumers.
 */
export function readFrame(buf: Buffer): { header?: { op?: number; t?: string }; body?: any } {
  const values = decodeMultiple(buf) as unknown[] | undefined;
  return { header: values?.[0] as { op?: number; t?: string }, body: values?.[1] };
}

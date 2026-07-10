import type { FastifyBaseLogger } from "fastify";

const CHAT_PROXY = "did:web:api.bsky.chat#bsky_chat";

export interface NotifierConfig {
  /** handle of the account that sends the DMs (linked via app password) */
  handle: string;
  /** app password for the sender — must be created with DM access enabled */
  appPassword: string;
  /** handle that receives the flag notifications */
  recipient: string;
  /** base URL of this dashboard, used to build deep links */
  dashboardUrl: string;
}

interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Record<string, unknown>[];
}

async function resolveHandleToDid(handle: string): Promise<string> {
  const res = await fetch(
    `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
  );
  if (!res.ok) throw new Error(`resolveHandle(${handle}) failed: ${res.status}`);
  const { did } = (await res.json()) as { did: string };
  return did;
}

async function resolvePdsEndpoint(did: string): Promise<string> {
  const url = did.startsWith("did:web:")
    ? `https://${did.slice("did:web:".length)}/.well-known/did.json`
    : `https://plc.directory/${did}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DID doc fetch for ${did} failed: ${res.status}`);
  const doc = (await res.json()) as {
    service?: { id: string; type: string; serviceEndpoint: string }[];
  };
  const svc = doc.service?.find(
    (s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
  );
  if (!svc) throw new Error(`no #atproto_pds service in DID doc for ${did}`);
  return svc.serviceEndpoint;
}

export class BskyDmNotifier {
  private session: { pds: string; accessJwt: string } | null = null;
  private recipientDid: string | null = null;
  private convoId: string | null = null;

  constructor(
    private cfg: NotifierConfig,
    private log: FastifyBaseLogger,
  ) {}

  /** Resolve the sender's DID + PDS from their handle, then create a session there. */
  private async ensureSession(): Promise<{ pds: string; accessJwt: string }> {
    if (this.session) return this.session;
    const did = await resolveHandleToDid(this.cfg.handle);
    const pds = await resolvePdsEndpoint(did);
    const res = await fetch(`${pds}/xrpc/com.atproto.server.createSession`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: did, password: this.cfg.appPassword }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`createSession for ${this.cfg.handle} failed: ${res.status} ${body}`);
    }
    const { accessJwt } = (await res.json()) as { accessJwt: string };
    this.session = { pds, accessJwt };
    return this.session;
  }

  /** Chat XRPC via the sender's PDS, service-proxied to the Bluesky chat appview. */
  private async chatXrpc(path: string, opts: RequestInit = {}, retry = true): Promise<any> {
    const { pds, accessJwt } = await this.ensureSession();
    const res = await fetch(`${pds}/xrpc/${path}`, {
      ...opts,
      headers: {
        ...opts.headers,
        Authorization: `Bearer ${accessJwt}`,
        "atproto-proxy": CHAT_PROXY,
        "Content-Type": "application/json",
      },
    });
    if (res.status === 401 && retry) {
      this.session = null; // token expired — re-auth once
      return this.chatXrpc(path, opts, false);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`chat ${path} failed: ${res.status} ${body}`);
    }
    return res.json();
  }

  private async ensureConvo(): Promise<string> {
    if (this.convoId) return this.convoId;
    this.recipientDid ??= await resolveHandleToDid(this.cfg.recipient);
    const { convo } = await this.chatXrpc(
      `chat.bsky.convo.getConvoForMembers?members=${encodeURIComponent(this.recipientDid)}`,
    );
    this.convoId = convo.id as string;
    return this.convoId;
  }

  async notifyFlags(account: { did: string; handle: string }, labels: string[]): Promise<void> {
    try {
      const convoId = await this.ensureConvo();

      // rich text with byte-offset facets: mention the account, link to the dashboard
      let text = "";
      const facets: Facet[] = [];
      const plain = (s: string) => {
        text += s;
      };
      const faceted = (s: string, feature: Record<string, unknown>) => {
        const byteStart = Buffer.byteLength(text);
        text += s;
        facets.push({ index: { byteStart, byteEnd: Buffer.byteLength(text) }, features: [feature] });
      };

      const link = `${this.cfg.dashboardUrl}/?q=${encodeURIComponent(account.handle)}`;
      plain("⚠️ ");
      faceted(`@${account.handle}`, { $type: "app.bsky.richtext.facet#mention", did: account.did });
      plain(` flagged: ${labels.join(", ")}\n`);
      faceted(link, { $type: "app.bsky.richtext.facet#link", uri: link });

      await this.chatXrpc("chat.bsky.convo.sendMessage", {
        method: "POST",
        body: JSON.stringify({ convoId, message: { text, facets } }),
      });
      this.log.info({ account: account.handle, labels }, "flag notification sent");
    } catch (err) {
      this.log.error({ err, account: account.handle }, "flag notification failed");
    }
  }
}

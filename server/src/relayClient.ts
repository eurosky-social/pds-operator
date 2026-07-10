export interface HostStatus {
  hostname: string;
  seq: number;
  accountCount: number;
  status: "active" | "idle" | "offline" | "throttled" | "banned";
}

export class RelayClient {
  constructor(private hostname: string) {}

  async getHostStatus(pdsHostname: string): Promise<HostStatus> {
    const res = await fetch(
      `https://${this.hostname}/xrpc/com.atproto.sync.getHostStatus?hostname=${encodeURIComponent(pdsHostname)}`,
    );
    if (!res.ok) throw new Error(`relay getHostStatus failed: ${res.status}`);
    return res.json();
  }

  async requestCrawl(pdsHostname: string): Promise<void> {
    const res = await fetch(`https://${this.hostname}/xrpc/com.atproto.sync.requestCrawl`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: pdsHostname }),
    });
    if (!res.ok) throw new Error(`relay requestCrawl failed: ${res.status}`);
  }
}

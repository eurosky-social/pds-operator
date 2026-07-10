async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: {
      ...(opts.body != null ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  return res.json();
}

export interface Account {
  did: string;
  handle: string;
  email?: string;
  indexedAt: string;
  status?: "active" | "takendown" | "deactivated";
  avatar?: string;
  labels?: string[];
}

export interface CursorStatus {
  relaySeq: number;
  relayStatus: string;
  accountCount: number;
  pdsHeadSeqApprox: number | null;
  gap: number | null;
  lastFullSync: string | null;
}

export const api = {
  session: () =>
    req<{
      authenticated: boolean;
      appviewUrl: string;
      pdsHostname: string;
      passwordLogin: boolean;
    }>("/api/session"),
  login: (password: string) => req<{ ok: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req<{ ok: true }>("/api/logout", { method: "POST" }),
  accounts: (opts: { q?: string; offset?: number; limit?: number; hideTakendown?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", opts.q);
    if (opts.offset) params.set("offset", String(opts.offset));
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.hideTakendown) params.set("hideTakendown", "1");
    const qs = params.toString();
    return req<{ accounts: Account[]; total: number; flaggedTotal: number }>(
      `/api/accounts${qs ? `?${qs}` : ""}`,
    );
  },
  takedown: (did: string) => req<{ ok: true }>(`/api/accounts/${encodeURIComponent(did)}/takedown`, { method: "POST" }),
  enable: (did: string) => req<{ ok: true }>(`/api/accounts/${encodeURIComponent(did)}/enable`, { method: "POST" }),
  resetPassword: (did: string) => req<{ ok: true }>(`/api/accounts/${encodeURIComponent(did)}/reset-password`, { method: "POST" }),
  cursorStatus: () => req<CursorStatus>("/api/status/cursor"),
  requestCrawl: () => req<{ ok: true }>("/api/status/request-crawl", { method: "POST" }),
  passkeyRegisterOptions: (enrollToken?: string) =>
    req<any>("/api/passkeys/options", { method: "POST", body: JSON.stringify({ enrollToken }) }),
  passkeyRegister: (name: string, response: unknown, enrollToken?: string) =>
    req<{ ok: true }>("/api/passkeys", {
      method: "POST",
      body: JSON.stringify({ name, response, enrollToken }),
    }),
  passkeys: () => req<{ passkeys: { id: string; name: string; createdAt: number }[] }>("/api/passkeys"),
  passkeyDelete: (id: string) =>
    req<{ ok: true }>(`/api/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  invites: () =>
    req<{
      codes: {
        code: string;
        available: number;
        disabled: boolean;
        createdAt: string;
        uses: { usedBy: string; usedAt: string }[];
      }[];
    }>("/api/invites"),
  inviteCreate: (useCount = 1) =>
    req<{ code: string }>("/api/invites", { method: "POST", body: JSON.stringify({ useCount }) }),
  inviteDisable: (code: string) =>
    req<{ ok: true }>("/api/invites/disable", { method: "POST", body: JSON.stringify({ code }) }),
  audit: () =>
    req<{ entries: { at: string; operator: string; action: string; target?: string }[] }>(
      "/api/audit?limit=500",
    ),
  passkeyLoginOptions: () => req<any>("/api/login/passkey/options", { method: "POST" }),
  passkeyLogin: (response: unknown) =>
    req<{ ok: true }>("/api/login/passkey", { method: "POST", body: JSON.stringify(response) }),
};

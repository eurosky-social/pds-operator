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
  storageBytes?: number | null;
}

export const formatBytes = (n: number | null | undefined): string => {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n;
  let unit = "B";
  for (const u of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = u;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${unit}`;
};

export interface CursorStatus {
  relaySeq: number;
  relayStatus: string;
  accountCount: number;
  pdsHeadSeqApprox: number | null;
  gap: number | null;
  lastFullSync: string | null;
}

export interface Stats {
  accounts: {
    total: number;
    active: number;
    takendown: number;
    deactivated: number;
    flagged: number;
  };
  activity: {
    active: number;
    dormant: number;
    avgDailyActive: number;
    newAccounts: number;
    writes: number;
    writesByDay: { day: string; n: number }[];
    topAccounts: { did: string; handle: string; avatar: string | null; n: number }[];
  };
  signups: { month: string; n: number }[];
  labels: { name: string; n: number }[];
}

export interface AccountStats {
  account: {
    did: string;
    handle: string;
    email?: string;
    status: string;
    avatar?: string;
    indexedAt: string;
    invitedBy?: { code: string; byHandle?: string };
    repoBytes: number | null;
    blobBytes: number | null;
  };
  labels: { src: string; val: string; cts: string }[];
  activity: {
    writesByDay: { day: string; n: number }[];
    windowWrites: number;
    activeDaysInWindow: number;
    allTimeWrites: number;
    firstActive: string | null;
    lastActive: string | null;
  };
}

export const api = {
  session: () =>
    req<{
      authenticated: boolean;
      operator: string | null;
      appviewUrl: string;
      pdsHostname: string;
      passwordLogin: boolean;
      pendingAdmins: boolean;
    }>("/api/session"),
  login: (password: string) => req<{ ok: true }>("/api/login", { method: "POST", body: JSON.stringify({ password }) }),
  logout: () => req<{ ok: true }>("/api/logout", { method: "POST" }),
  accounts: (
    opts: {
      q?: string;
      offset?: number;
      limit?: number;
      hideTakendown?: boolean;
      sort?: "storage";
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", opts.q);
    if (opts.offset) params.set("offset", String(opts.offset));
    if (opts.limit) params.set("limit", String(opts.limit));
    if (opts.hideTakendown) params.set("hideTakendown", "1");
    if (opts.sort) params.set("sort", opts.sort);
    const qs = params.toString();
    return req<{ accounts: Account[]; total: number; flaggedTotal: number }>(
      `/api/accounts${qs ? `?${qs}` : ""}`,
    );
  },
  takedown: (did: string) => req<{ ok: true }>(`/api/accounts/${encodeURIComponent(did)}/takedown`, { method: "POST" }),
  enable: (did: string) => req<{ ok: true }>(`/api/accounts/${encodeURIComponent(did)}/enable`, { method: "POST" }),
  purgeRecords: (did: string) => req<{ ok: true; deleted: number }>(`/api/accounts/${encodeURIComponent(did)}/purge-records`, { method: "POST" }),
  resetPassword: (did: string) => req<{ ok: true; password: string }>(`/api/accounts/${encodeURIComponent(did)}/reset-password`, { method: "POST" }),
  cursorStatus: () => req<CursorStatus>("/api/status/cursor"),
  requestCrawl: (relay?: string) =>
    req<{ ok: true }>("/api/status/request-crawl", {
      method: "POST",
      body: relay ? JSON.stringify({ relay }) : undefined,
    }),
  passkeyRegisterOptions: (enrollToken?: string) =>
    req<any>("/api/passkeys/options", { method: "POST", body: JSON.stringify({ enrollToken }) }),
  passkeyRegister: (name: string, response: unknown, enrollToken?: string) =>
    req<{ ok: true }>("/api/passkeys", {
      method: "POST",
      body: JSON.stringify({ name, response, enrollToken }),
    }),
  passkeys: () =>
    req<{ passkeys: { id: string; name: string; createdAt: number; operator: string | null }[] }>(
      "/api/passkeys",
    ),
  operators: () =>
    req<{
      operators: {
        did: string;
        handle: string;
        avatar?: string;
        addedAt: number;
        enrolledAt: number | null;
        passkeys: number;
      }[];
    }>("/api/operators"),
  operatorAdd: (handle: string) =>
    req<{ ok: true; did: string }>("/api/operators", {
      method: "POST",
      body: JSON.stringify({ handle }),
    }),
  operatorRemove: (did: string) =>
    req<{ ok: true }>(`/api/operators/${encodeURIComponent(did)}`, { method: "DELETE" }),
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
  stats: (days = 30, months = 12, activeDays = 30) =>
    req<Stats>(
      `/api/stats?days=${days}&months=${months}&activeDays=${activeDays}&tz=${encodeURIComponent(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      )}`,
    ),
  accountStats: (did: string, days = 30) =>
    req<AccountStats>(
      `/api/stats/accounts/${encodeURIComponent(did)}?days=${days}&tz=${encodeURIComponent(
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      )}`,
    ),
  audit: () =>
    req<{ entries: { at: string; operator: string; action: string; target?: string }[] }>(
      "/api/audit?limit=500",
    ),
  passkeyLoginOptions: () => req<any>("/api/login/passkey/options", { method: "POST" }),
  passkeyLogin: (response: unknown) =>
    req<{ ok: true }>("/api/login/passkey", { method: "POST", body: JSON.stringify(response) }),
};

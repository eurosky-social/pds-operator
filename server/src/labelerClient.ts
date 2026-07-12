export interface Label {
  src: string;
  uri: string;
  val: string;
  cts: string;
  neg?: boolean;
  exp?: string;
}

/** A labeler to listen to, plus which of its label values count as flags (empty = all). */
export interface WatchedLabeler {
  did: string;
  client: LabelerClient;
  watch: Set<string>;
}

/** SQL predicate for "this account carries a watched label", for queries over `accounts`. */
export function watchedLabelPredicate(labelers: WatchedLabeler[]): {
  expr: string;
  params: unknown[];
} {
  const conds: string[] = [];
  const params: unknown[] = [];
  for (const l of labelers) {
    if (l.watch.size === 0) {
      conds.push("l.src = ?");
      params.push(l.did);
    } else {
      conds.push(`(l.src = ? AND l.val IN (${[...l.watch].map(() => "?").join(",")}))`);
      params.push(l.did, ...l.watch);
    }
  }
  const expr =
    conds.length > 0
      ? `EXISTS (SELECT 1 FROM labels l WHERE l.did = accounts.did AND (${conds.join(" OR ")}))`
      : "0";
  return { expr, params };
}

export class LabelerClient {
  private endpoint: string | null = null;

  constructor(public readonly did: string) {}

  async resolveEndpoint(): Promise<string> {
    if (this.endpoint) return this.endpoint;
    const res = await fetch(`https://plc.directory/${this.did}`);
    if (!res.ok) throw new Error(`labeler DID resolution failed: ${res.status}`);
    const doc = (await res.json()) as {
      service?: { id: string; type: string; serviceEndpoint: string }[];
    };
    const svc = doc.service?.find((s) => s.id === "#atproto_labeler" || s.type === "AtprotoLabeler");
    if (!svc) throw new Error(`no #atproto_labeler service in DID document for ${this.did}`);
    this.endpoint = svc.serviceEndpoint;
    return this.endpoint;
  }

  /**
   * Query current labels for a batch of URIs (DIDs). Ozone silently returns an empty
   * result — not an error — past 20 uriPatterns per query, so callers must batch at ≤20.
   */
  async queryLabels(uris: string[]): Promise<Label[]> {
    const endpoint = await this.resolveEndpoint();
    const params = new URLSearchParams({ limit: "250" });
    for (const uri of uris) params.append("uriPatterns", uri);
    const res = await fetch(`${endpoint}/xrpc/com.atproto.label.queryLabels?${params}`);
    if (!res.ok) throw new Error(`labeler queryLabels failed: ${res.status}`);
    const { labels } = (await res.json()) as { labels: Label[] };
    return labels;
  }
}

/**
 * Fetch a labeler's published label definitions (app.bsky.labeler.service/self on its PDS)
 * and map label identifiers to human-readable names, e.g.
 * "platform-manipulation" → "Platform Abuse & Manipulation".
 */
export async function fetchLabelNames(did: string): Promise<Map<string, string>> {
  const docUrl = did.startsWith("did:web:")
    ? `https://${did.slice("did:web:".length)}/.well-known/did.json`
    : `https://plc.directory/${did}`;
  const docRes = await fetch(docUrl);
  if (!docRes.ok) throw new Error(`DID doc fetch for ${did} failed: ${docRes.status}`);
  const doc = (await docRes.json()) as {
    service?: { id: string; type: string; serviceEndpoint: string }[];
  };
  const pds = doc.service?.find(
    (s) => s.id === "#atproto_pds" || s.type === "AtprotoPersonalDataServer",
  );
  if (!pds) throw new Error(`no #atproto_pds service in DID doc for ${did}`);

  const recRes = await fetch(
    `${pds.serviceEndpoint}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=app.bsky.labeler.service&rkey=self`,
  );
  if (!recRes.ok) throw new Error(`labeler service record fetch failed: ${recRes.status}`);
  const record = (await recRes.json()) as {
    value?: {
      policies?: {
        labelValueDefinitions?: {
          identifier: string;
          locales?: { lang: string; name: string }[];
        }[];
      };
    };
  };

  const names = new Map<string, string>();
  for (const def of record.value?.policies?.labelValueDefinitions ?? []) {
    const locale =
      def.locales?.find((l) => l.lang?.startsWith("en")) ?? def.locales?.[0];
    if (locale?.name) names.set(def.identifier, locale.name);
  }
  return names;
}

/** Reduce raw labels to the currently-active set per URI (negations and expirations applied). */
export function activeLabels(raw: Label[], src: string): Map<string, Map<string, string>> {
  // apply in timestamp order so a later neg (retraction) cancels an earlier label
  const sorted = [...raw].sort((a, b) => a.cts.localeCompare(b.cts));
  const nowIso = new Date().toISOString();
  const byUri = new Map<string, Map<string, string>>(); // uri -> val -> cts
  for (const label of sorted) {
    if (label.src !== src) continue;
    if (label.exp && label.exp <= nowIso) continue;
    const vals = byUri.get(label.uri) ?? new Map<string, string>();
    if (label.neg) vals.delete(label.val);
    else vals.set(label.val, label.cts);
    byUri.set(label.uri, vals);
  }
  return byUri;
}

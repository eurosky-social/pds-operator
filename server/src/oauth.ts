import { MemoryStore, OAuthClient, type StoredState } from "@atcute/oauth-node-client";
import {
  CompositeDidDocumentResolver,
  CompositeHandleResolver,
  LocalActorResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import { NodeDnsHandleResolver } from "@atcute/identity-resolver-node";

/**
 * atproto OAuth is used purely to prove control of a DID during admin enrollment,
 * so the scope is just "atproto" (identity only, no resource grants) and tokens are
 * revoked as soon as the callback has read the DID.
 *
 * Prod (https dashboard) runs as a discoverable public client whose metadata is
 * served by this server. Dev (http dashboard) runs as a loopback client, where the
 * client_id is derived from the redirect URI and no hosted metadata is needed.
 * Loopback redirect URIs must use 127.0.0.1, not localhost.
 */
export function createOAuthClient(dashboardUrl: string) {
  const isLoopback = dashboardUrl.startsWith("http://");
  const redirectUri = isLoopback
    ? `${dashboardUrl.replace("//localhost", "//127.0.0.1")}/api/oauth/callback`
    : `${dashboardUrl}/api/oauth/callback`;

  return new OAuthClient({
    metadata: {
      ...(isLoopback ? {} : { client_id: `${dashboardUrl}/oauth/client-metadata.json` }),
      redirect_uris: [redirectUri],
      scope: "atproto",
    },
    // no keyset: public client, which is plenty for one-shot authentication
    stores: {
      sessions: new MemoryStore(),
      states: new MemoryStore<string, StoredState>({ maxSize: 100, ttl: 10 * 60_000 }),
    },
    actorResolver: new LocalActorResolver({
      handleResolver: new CompositeHandleResolver({
        methods: {
          dns: new NodeDnsHandleResolver(),
          http: new WellKnownHandleResolver(),
        },
      }),
      didDocumentResolver: new CompositeDidDocumentResolver({
        methods: {
          plc: new PlcDidDocumentResolver(),
          web: new WebDidDocumentResolver(),
        },
      }),
    }),
  });
}

export type DashboardOAuthClient = ReturnType<typeof createOAuthClient>;

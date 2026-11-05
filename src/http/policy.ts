/** Security policy for the hosted (Vercel) deployment of this fork.
 *
 *  The hosted server runs with the owner's AniList token, so it only exposes
 *  what a personal watchlist needs. Everything here is deny-by-default:
 *  a new upstream tool that posts, likes or favourites is blocked at the
 *  AniList client even if nobody remembers to add it to BLOCKED_TOOLS.
 */

/** Tools never registered on the hosted server. */
export const BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "anilist_activity", // posts a public text activity
  "anilist_react", // likes / replies to other people's activity
  "anilist_favourite", // toggles public favourites
]);

/** The only GraphQL mutations the hosted server may send to AniList.
 *  Both only touch the owner's own list entries. */
export const ALLOWED_MUTATIONS: ReadonlySet<string> = new Set([
  "SaveMediaListEntry",
  "DeleteMediaListEntry",
]);

/** Names of every mutation operation in a GraphQL document.
 *  Anonymous mutations yield "" so they are always rejected. A document can
 *  hold several operations, so all of them are checked, not just the first.
 *  Fail-closed: the word "mutation" anywhere outside a comment counts. */
export function mutationNames(query: string): string[] {
  const cleaned = query.replace(/#[^\n]*/g, "");
  const names: string[] = [];
  for (const m of cleaned.matchAll(/\bmutation\b\s*([A-Za-z_][A-Za-z0-9_]*)?/g)) {
    names.push(m[1] ?? "");
  }
  return names;
}

/** Hosts the server may talk to. AniList for everything, Jikan/Kitsu only
 *  for the public MAL/Kitsu list imports (no token is sent there). */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "graphql.anilist.co",
  "api.jikan.moe",
  "kitsu.io",
]);

/** Wrap a fetch implementation so it enforces ALLOWED_HOSTS and, for
 *  AniList GraphQL calls, ALLOWED_MUTATIONS. Applied once at startup. */
export function guardFetch(inner: typeof fetch): typeof fetch {
  const guarded = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
      throw new Error(`Blocked by server policy: outbound request to ${url.hostname}`);
    }
    if (url.hostname === "graphql.anilist.co") {
      const body = init?.body;
      if (typeof body !== "string") {
        throw new Error("Blocked by server policy: unreadable AniList request body");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error("Blocked by server policy: AniList request body is not JSON");
      }
      const docs = Array.isArray(parsed) ? parsed : [parsed];
      for (const doc of docs) {
        const q = (doc as { query?: unknown })?.query;
        if (typeof q !== "string") throw new Error("Blocked by server policy: missing query");
        assertMutationAllowed(q);
      }
    }
    return inner(input, init);
  };
  return guarded as typeof fetch;
}

const GUARDED = Symbol.for("ani-mcp.fetch-guarded");

/** Install the guard on globalThis.fetch if it isn't already the guarded one.
 *  Called at startup AND at the start of every request, so a library that
 *  replaces fetch later cannot silently remove the policy. */
export function ensureFetchGuard(): void {
  const current = globalThis.fetch as typeof fetch & { [GUARDED]?: true };
  if (current[GUARDED]) return;
  const guarded = guardFetch(current.bind(globalThis)) as typeof fetch & { [GUARDED]?: true };
  guarded[GUARDED] = true;
  globalThis.fetch = guarded;
}

export function assertMutationAllowed(query: string): void {
  for (const name of mutationNames(query)) {
    if (!ALLOWED_MUTATIONS.has(name)) {
      throw new Error(
        `Blocked by server policy: mutation "${name || "anonymous"}" is not allowed on this deployment.`,
      );
    }
  }
}

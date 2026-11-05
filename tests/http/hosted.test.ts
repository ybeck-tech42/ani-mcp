/** Tests for the hardened Vercel deployment (src/http/*). AniList is mocked via MSW. */

import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  mutationNames,
  assertMutationAllowed,
  guardFetch,
  BLOCKED_TOOLS,
} from "../../src/http/policy.js";
import { matchTemplate } from "../../src/http/collector.js";

const SECRET = "s".repeat(16) + "0123456789abcdefXYZ"; // 35 chars
process.env.MCP_SECRET = SECRET;
process.env.ANILIST_TOKEN = "x".repeat(120);
process.env.ANILIST_USERNAME = "testuser";

// Import after env is set: the module patches global fetch and builds tools on load.
const { default: handler, collector, keyMatches } = await import("../../src/http/vercel.js");

describe("policy: mutation allowlist", () => {
  it("finds every mutation in a document", () => {
    expect(mutationNames("query A { x }")).toEqual([]);
    expect(mutationNames("mutation SaveMediaListEntry($id: Int) { x }")).toEqual(["SaveMediaListEntry"]);
    expect(mutationNames("query A { x } mutation ToggleLike { y }")).toEqual(["ToggleLike"]);
    expect(mutationNames("mutation { y }")).toEqual([""]);
    expect(mutationNames("# mutation ToggleLike\nquery A { x }")).toEqual([]);
  });

  it("allows only list-entry mutations", () => {
    expect(() => assertMutationAllowed("mutation SaveMediaListEntry { a }")).not.toThrow();
    expect(() => assertMutationAllowed("mutation DeleteMediaListEntry { a }")).not.toThrow();
    for (const m of ["ToggleLike", "SaveTextActivity", "SaveActivityReply", "ToggleFavourite", "UpdateUser"]) {
      expect(() => assertMutationAllowed(`mutation ${m} { a }`)).toThrow(/Blocked by server policy/);
    }
    expect(() => assertMutationAllowed("mutation { a }")).toThrow(/anonymous/);
    expect(() =>
      assertMutationAllowed("mutation SaveMediaListEntry { a } mutation ToggleLike { b }"),
    ).toThrow(/ToggleLike/);
  });
});

describe("policy: fetch guard", () => {
  const ok = async () => new Response("{}");
  const guarded = guardFetch(ok as unknown as typeof fetch);
  const body = (query: string) => ({ method: "POST", body: JSON.stringify({ query }) });

  it("blocks hosts outside the allowlist and plain http", async () => {
    await expect(guarded("https://evil.example.com/x")).rejects.toThrow(/evil\.example\.com/);
    await expect(guarded("http://graphql.anilist.co", body("query A { x }"))).rejects.toThrow(/Blocked/);
  });

  it("blocks disallowed AniList mutations, including batched documents", async () => {
    await expect(guarded("https://graphql.anilist.co", body("mutation ToggleLike { x }"))).rejects.toThrow(/ToggleLike/);
    const batch = { method: "POST", body: JSON.stringify([{ query: "query A { x }" }, { query: "mutation SaveTextActivity { y }" }]) };
    await expect(guarded("https://graphql.anilist.co", batch)).rejects.toThrow(/SaveTextActivity/);
    await expect(guarded("https://graphql.anilist.co", { method: "POST" })).rejects.toThrow(/unreadable/);
  });

  it("lets reads and list mutations through", async () => {
    await expect(guarded("https://graphql.anilist.co", body("query A { x }"))).resolves.toBeInstanceOf(Response);
    await expect(guarded("https://graphql.anilist.co", body("mutation SaveMediaListEntry { x }"))).resolves.toBeInstanceOf(Response);
    await expect(guarded("https://api.jikan.moe/v4/users/x")).resolves.toBeInstanceOf(Response);
  });
});

describe("collector", () => {
  const names = [...collector.tools.keys()];

  it("drops blocked social/public tools and image cards", () => {
    for (const blocked of BLOCKED_TOOLS) expect(names).not.toContain(blocked);
    expect(names.filter((n) => n.endsWith("_card"))).toEqual([]);
    expect(collector.skipped.sort()).toEqual([...BLOCKED_TOOLS].sort());
  });

  it("keeps the watchlist tools", () => {
    for (const t of [
      "anilist_search", "anilist_list", "anilist_add_to_list", "anilist_update_progress",
      "anilist_delete_from_list", "anilist_batch_update", "anilist_undo", "anilist_sequels",
      "anilist_airing", "anilist_schedule", "anilist_mal_import", "anilist_export",
    ]) expect(names).toContain(t);
  });

  it("matches resource templates", () => {
    expect(matchTemplate("anilist://list/{type}", "anilist://list/ANIME")).toEqual({ type: "ANIME" });
    expect(matchTemplate("anilist://list/{type}", "anilist://other/ANIME")).toBeNull();
  });
});

describe("hosted HTTP handler", () => {
  // Call the handler directly with minimal req/res doubles (no network).
  async function call(path: string, opts: { method?: string; body?: unknown; rawBody?: string } = {}) {
    const m = path.match(/^\/c\/([^/]*)\/mcp$/);
    const req = Object.assign(Readable.from(opts.rawBody !== undefined ? [opts.rawBody] : []), {
      method: opts.method ?? "POST",
      url: path,
      headers: { "content-type": "application/json" },
      query: m ? { key: m[1] } : {},
      body: opts.rawBody !== undefined ? undefined : opts.body,
    });
    let status = 0;
    let data = "";
    const headers: Record<string, string> = {};
    const res = {
      set statusCode(v: number) { status = v; },
      get statusCode() { return status; },
      setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; },
      end(chunk?: string) { if (chunk) data += chunk; },
    };
    await handler(req as never, res as never);
    return { status, headers, json: data ? JSON.parse(data) : null };
  }
  const rpc = (path: string, msg: unknown) => call(path, { body: msg });
  const raw = (path: string, init: { method?: string; body?: string }) =>
    call(path, { method: init.method, rawBody: init.body });
  const good = `/c/${SECRET}/mcp`;

  it("rejects wrong keys and weak secrets", async () => {
    expect((await rpc("/c/wrong/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
    expect((await rpc("/c/" + SECRET.slice(0, -1) + "Q/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
    expect(keyMatches("short", "short")).toBe(false); // secrets under 32 chars never match
    expect(keyMatches(SECRET)).toBe(true);
  });

  it("speaks MCP: initialize, notifications, GET", async () => {
    const init = await rpc(good, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.status).toBe(200);
    expect((init.json as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    expect((await rpc(good, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await raw(good, { method: "GET" })).status).toBe(405);
    expect((await raw(good, { body: "{bad" })).status).toBe(400);
  });

  it("lists tools with object input schemas", async () => {
    const res = await rpc(good, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = (res.json as { result: { tools: { name: string; inputSchema: { type: string } }[] } }).result.tools;
    expect(tools.length).toBe(collector.tools.size);
    expect(tools.every((t) => t.inputSchema.type === "object")).toBe(true);
    expect(tools.map((t) => t.name)).not.toContain("anilist_activity");
  });

  it("validates arguments and runs a real tool against mocked AniList", async () => {
    const bad = await rpc(good, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "anilist_search", arguments: { query: "" } } });
    expect((bad.json as { result: { isError: boolean } }).result.isError).toBe(true);

    const okRes = await rpc(good, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "anilist_search", arguments: { query: "frieren" } } });
    const result = (okRes.json as { result: { isError?: boolean; content: { text: string }[] } }).result;
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("re-installs the fetch guard on every request, even if fetch was replaced", async () => {
    // Simulate a library swapping in its own, unguarded fetch after startup.
    const original = globalThis.fetch;
    const unguarded = (async () => new Response("{}")) as unknown as typeof fetch;
    globalThis.fetch = unguarded;
    try {
      await expect(fetch("https://evil.example.com/")).resolves.toBeInstanceOf(Response); // hole is real
      await rpc(good, { jsonrpc: "2.0", id: 10, method: "ping" });
      expect(globalThis.fetch).not.toBe(unguarded); // the next request closed it
      await expect(fetch("https://evil.example.com/")).rejects.toThrow(/Blocked by server policy/);
      await expect(
        fetch("https://graphql.anilist.co", { method: "POST", body: JSON.stringify({ query: "mutation ToggleLike($id: Int) { ToggleLike(id: $id) { id } }" }) }),
      ).rejects.toThrow(/ToggleLike/);
    } finally {
      globalThis.fetch = original;
    }
    // Reads still reach (mocked) AniList through the guard.
    const res = await rpc(good, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "anilist_search", arguments: { query: "frieren" } } });
    expect((res.json as { result: { isError?: boolean } }).result.isError).toBeFalsy();
  });

  it("refuses blocked tools by name", async () => {
    const res = await rpc(good, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "anilist_favourite", arguments: {} } });
    expect((res.json as { error: { code: number } }).error.code).toBe(-32602);
  });

  it("serves prompts and resources", async () => {
    const p = await rpc(good, { jsonrpc: "2.0", id: 6, method: "prompts/list" });
    expect((p.json as { result: { prompts: unknown[] } }).result.prompts.length).toBeGreaterThan(0);
    const r = await rpc(good, { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "anilist://status" } });
    expect((r.json as { result: { contents: { text: string }[] } }).result.contents[0].text).toMatch(/token configured/);
  });
});

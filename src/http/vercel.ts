/** Vercel serverless entry for the hosted, hardened deployment.
 *
 *  Reached only through /c/<MCP_SECRET>/mcp (see vercel.json). Any other key,
 *  a missing or too-short MCP_SECRET, or a non-POST request gets an empty 404/405,
 *  so the endpoint reveals nothing to scanners.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ensureFetchGuard } from "./policy.js";
import { buildCollector } from "./collector.js";
import { createRpcHandler, type JsonRpcMessage } from "./rpc.js";

const MIN_SECRET_LENGTH = 32;

// Same env sanitization as the stdio entry point (src/index.ts).
for (const key of ["ANILIST_USERNAME", "ANILIST_TOKEN"] as const) {
  const val = process.env[key] ?? "";
  if (!val || val.startsWith("${") || val === "undefined" || val === "null") process.env[key] = "";
}
if (process.env.ANILIST_TOKEN && process.env.ANILIST_TOKEN.length < 30) process.env.ANILIST_TOKEN = "";

// Enforce outbound host + mutation allowlist for every request the tools make.
// Upstream modules call the global `fetch` at request time, so patching here
// (after imports are evaluated) still covers them. This also makes
// ANILIST_API_URL / KITSU_API_URL overrides harmless: other hosts are refused.
ensureFetchGuard();

const collector = buildCollector();
const handle = createRpcHandler(collector, { name: "ani-mcp (hardened)", version: "0.15.8-hosted" });

export function keyMatches(given: unknown, expected = process.env.MCP_SECRET): boolean {
  if (typeof expected !== "string" || expected.length < MIN_SECRET_LENGTH) return false;
  if (typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

type VercelRequest = IncomingMessage & { query?: Record<string, unknown>; body?: unknown };

async function readBody(req: VercelRequest): Promise<unknown> {
  if (req.body !== undefined && req.body !== null && typeof req.body !== "string") return req.body;
  let raw = typeof req.body === "string" ? req.body : "";
  if (!raw) {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 1_000_000) throw new Error("Body too large");
    }
  }
  return JSON.parse(raw);
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (body === undefined) {
    res.end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

export default async function handler(req: VercelRequest, res: ServerResponse): Promise<void> {
  ensureFetchGuard();
  const key = req.query?.key ?? new URL(req.url ?? "/", "http://x").searchParams.get("key");
  if (!keyMatches(key)) return send(res, 404, { error: "Not found" });
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" }, { Allow: "POST" });

  let payload: unknown;
  try {
    payload = await readBody(req);
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  if (Array.isArray(payload)) {
    const out = (await Promise.all(payload.map((m) => handle(m as JsonRpcMessage)))).filter(Boolean);
    return out.length ? send(res, 200, out) : send(res, 202);
  }
  const out = await handle(payload as JsonRpcMessage);
  return out ? send(res, 200, out) : send(res, 202);
}

export { collector };

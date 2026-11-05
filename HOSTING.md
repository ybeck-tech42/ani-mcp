# Hosted deployment (Vercel) — hardened fork

This fork adds a serverless entry point so ani-mcp can run on Vercel and be added
to Claude as a **custom connector** (claude.ai, desktop and mobile). The upstream
stdio/HTTP server in `src/index.ts` is unchanged.

## What is different from upstream

| | Upstream HTTP mode | This deployment |
|---|---|---|
| Access control | none | secret URL segment, constant-time check, 404 otherwise |
| Tools | 56 | 48 — no posting, liking/replying, favouriting, image cards |
| AniList mutations | any | only `SaveMediaListEntry`, `DeleteMediaListEntry` (enforced at `fetch`) |
| Outbound hosts | any | `graphql.anilist.co`, `api.jikan.moe`, `kitsu.io` over HTTPS only |
| Runtime | long-running server | stateless Vercel function |

Code: `src/http/` (`policy.ts` = security rules, `collector.ts` = tool registry,
`rpc.ts` = MCP JSON-RPC, `vercel.ts` = entry). Tests: `tests/http/hosted.test.ts`.

The fetch guard is re-applied on every request, so a dependency that replaces
`globalThis.fetch` cannot silently remove it.

## Setup

1. **Vercel:** Add New → Project → import this repo. Settings come from `vercel.json`.
2. **Environment variables** (Settings → Environment Variables, Production):
   - `ANILIST_TOKEN` — from anilist.co/settings/developer (redirect URL
     `https://anilist.co/api/v2/oauth/pin`, then open
     `https://anilist.co/api/v2/oauth/authorize?client_id=<ID>&response_type=token`)
   - `ANILIST_USERNAME` — your AniList username (not secret)
   - `MCP_SECRET` — random string, **at least 32 characters** (password generator)
3. Redeploy so the variables take effect.
4. **Claude:** Settings → Connectors → Add custom connector →
   `https://<project>.vercel.app/c/<MCP_SECRET>/mcp`. Treat this URL like a password.
5. In the connector's tool permissions, set write tools (`anilist_add_to_list`,
   `anilist_update_progress`, `anilist_delete_from_list`, `anilist_batch_update`,
   `anilist_undo`, imports) to **ask before use**.

## If something leaks

- URL leaked → change `MCP_SECRET` in Vercel and redeploy; update the connector URL.
- Token leaked → revoke it in AniList settings (Apps / Developer), create a new one.

## Known limitations

- `anilist_undo` keeps its history in memory; on serverless it only works while the
  same instance is warm.
- Deployment Protection must allow the production domain to be reached publicly
  (Vercel's default protects preview URLs only).

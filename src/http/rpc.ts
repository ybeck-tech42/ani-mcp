/** Stateless MCP JSON-RPC handler (Streamable HTTP, JSON responses only). */

import { z } from "zod";
import { type Collector, matchTemplate } from "./collector.js";

const SUPPORTED_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const LATEST = "2025-06-18";

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type Content = { type: string; [k: string]: unknown };

function toContent(value: unknown): Content[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (value && typeof value === "object" && Array.isArray((value as { content?: unknown }).content)) {
    return (value as { content: Content[] }).content;
  }
  return [{ type: "text", text: JSON.stringify(value, null, 1) }];
}

function inputSchema(schema: z.ZodType | undefined): Record<string, unknown> {
  if (!schema) return { type: "object", properties: {} };
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== "object") return { type: "object", properties: {} };
  return json;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

export function createRpcHandler(collector: Collector, serverInfo: { name: string; version: string }) {
  // Build tool listing once; schemas don't change at runtime.
  const toolList = [...collector.tools.values()].map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: inputSchema(t.parameters),
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }));

  async function callTool(params: Record<string, unknown> | undefined) {
    const name = params?.name;
    const tool = typeof name === "string" ? collector.tools.get(name) : undefined;
    if (!tool) return { error: { code: -32602, message: `Unknown tool: ${String(name)}` } };

    let args: unknown = params?.arguments ?? {};
    if (tool.parameters) {
      const parsed = tool.parameters.safeParse(args);
      if (!parsed.success) {
        return {
          result: {
            content: [{ type: "text", text: `Invalid arguments: ${z.prettifyError(parsed.error)}` }],
            isError: true,
          },
        };
      }
      args = parsed.data; // applies schema defaults, like FastMCP does
    }
    try {
      const value = await tool.execute(args, {});
      return { result: { content: toContent(value) } };
    } catch (err) {
      return { result: { content: [{ type: "text", text: errorText(err) }], isError: true } };
    }
  }

  async function getPrompt(params: Record<string, unknown> | undefined) {
    const prompt = collector.prompts.get(String(params?.name));
    if (!prompt) return { error: { code: -32602, message: `Unknown prompt: ${String(params?.name)}` } };
    const args = (params?.arguments ?? {}) as Record<string, string | undefined>;
    for (const a of prompt.arguments ?? []) {
      if (a.required && !args[a.name]) {
        return { error: { code: -32602, message: `Missing required argument: ${a.name}` } };
      }
    }
    const out = (await prompt.load(args)) as unknown;
    if (typeof out === "string") {
      return { result: { messages: [{ role: "user", content: { type: "text", text: out } }] } };
    }
    return { result: out };
  }

  async function readResource(params: Record<string, unknown> | undefined) {
    const uri = String(params?.uri ?? "");
    const fixed = collector.resources.get(uri);
    let value: unknown;
    let mimeType: string | undefined;
    if (fixed) {
      value = await fixed.load();
      mimeType = fixed.mimeType;
    } else {
      let found: { t: (typeof collector.templates)[number]; vars: Record<string, string> } | undefined;
      for (const t of collector.templates) {
        const vars = matchTemplate(t.uriTemplate, uri);
        if (vars) {
          found = { t, vars };
          break;
        }
      }
      if (!found) return { error: { code: -32002, message: `Resource not found: ${uri}` } };
      value = await found.t.load(found.vars);
      mimeType = found.t.mimeType;
    }
    const text =
      typeof value === "string"
        ? value
        : typeof (value as { text?: unknown })?.text === "string"
          ? (value as { text: string }).text
          : JSON.stringify(value);
    return { result: { contents: [{ uri, mimeType: mimeType ?? "text/plain", text }] } };
  }

  return async function handle(msg: JsonRpcMessage): Promise<Record<string, unknown> | null> {
    const isNotification = msg == null || msg.id === undefined || msg.id === null;
    const reply = (body: Record<string, unknown>) =>
      isNotification ? null : { jsonrpc: "2.0", id: msg.id, ...body };

    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return isNotification ? null : { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid request" } };
    }

    try {
      switch (msg.method) {
        case "initialize": {
          const requested = msg.params?.protocolVersion;
          return reply({
            result: {
              protocolVersion:
                typeof requested === "string" && SUPPORTED_VERSIONS.includes(requested) ? requested : LATEST,
              capabilities: {
                tools: { listChanged: false },
                prompts: { listChanged: false },
                resources: { listChanged: false, subscribe: false },
              },
              serverInfo,
              instructions:
                "AniList tools for the owner's personal anime/manga list. " +
                "Look up IDs with anilist_search before writing. Seasons and sequels are separate entries. " +
                "Use dryRun first for anilist_batch_update and imports. Posting, liking and favouriting are disabled on this server.",
            },
          });
        }
        case "ping":
          return reply({ result: {} });
        case "tools/list":
          return reply({ result: { tools: toolList } });
        case "tools/call":
          return reply(await callTool(msg.params));
        case "prompts/list":
          return reply({
            result: {
              prompts: [...collector.prompts.values()].map((p) => ({
                name: p.name,
                description: p.description,
                arguments: p.arguments ?? [],
              })),
            },
          });
        case "prompts/get":
          return reply(await getPrompt(msg.params));
        case "resources/list":
          return reply({
            result: {
              resources: [...collector.resources.values()].map((r) => ({
                uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType,
              })),
            },
          });
        case "resources/templates/list":
          return reply({
            result: {
              resourceTemplates: collector.templates.map((t) => ({
                uriTemplate: t.uriTemplate, name: t.name, description: t.description, mimeType: t.mimeType,
              })),
            },
          });
        case "resources/read":
          return reply(await readResource(msg.params));
        default:
          if (msg.method.startsWith("notifications/")) return null;
          return reply({ error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
    } catch (err) {
      return reply({ error: { code: -32603, message: errorText(err) } });
    }
  };
}

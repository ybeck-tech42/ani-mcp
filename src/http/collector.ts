/** Collects tools, prompts and resources registered through the FastMCP API
 *  so they can be served by a stateless serverless handler.
 *
 *  Upstream code calls `server.addTool(...)` etc.; this class implements just
 *  that registration surface. Nothing from FastMCP's runtime is used.
 */

import type { FastMCP } from "fastmcp";
import type { z } from "zod";
import { BLOCKED_TOOLS } from "./policy.js";
import { registerSearchTools } from "../tools/search.js";
import { registerListTools } from "../tools/lists.js";
import { registerRecommendTools } from "../tools/recommend.js";
import { registerDiscoverTools } from "../tools/discover.js";
import { registerInfoTools } from "../tools/info.js";
import { registerWriteTools } from "../tools/write.js";
import { registerSocialTools } from "../tools/social.js";
import { registerAnalyticsTools } from "../tools/analytics.js";
import { registerImportTools } from "../tools/import.js";
import { registerResources } from "../resources.js";
import { registerPrompts } from "../prompts.js";
// Not registered on purpose: ../tools/cards.js (image cards, needs native `sharp`).

export interface ToolDef {
  name: string;
  description?: string;
  parameters?: z.ZodType;
  annotations?: Record<string, unknown>;
  execute: (args: unknown, context?: unknown) => Promise<unknown>;
}

export interface PromptArg {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptDef {
  name: string;
  description?: string;
  arguments?: PromptArg[];
  load: (args: Record<string, string | undefined>) => Promise<unknown>;
}

export interface ResourceDef {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  load: () => Promise<unknown>;
}

export interface ResourceTemplateDef {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  arguments?: PromptArg[];
  load: (args: Record<string, string>) => Promise<unknown>;
}

export class Collector {
  readonly tools = new Map<string, ToolDef>();
  readonly prompts = new Map<string, PromptDef>();
  readonly resources = new Map<string, ResourceDef>();
  readonly templates: ResourceTemplateDef[] = [];
  readonly skipped: string[] = [];

  addTool(tool: ToolDef): void {
    if (BLOCKED_TOOLS.has(tool.name)) {
      this.skipped.push(tool.name);
      return;
    }
    if (this.tools.has(tool.name)) throw new Error(`Duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  addPrompt(prompt: PromptDef): void {
    this.prompts.set(prompt.name, prompt);
  }

  addResource(resource: ResourceDef): void {
    this.resources.set(resource.uri, resource);
  }

  addResourceTemplate(template: ResourceTemplateDef): void {
    this.templates.push(template);
  }

  /** Upstream register functions are typed against FastMCP; we only
   *  implement the add* methods they call. */
  asServer(): FastMCP {
    return this as unknown as FastMCP;
  }
}

export function buildCollector(): Collector {
  const c = new Collector();
  const s = c.asServer();
  registerSearchTools(s);
  registerListTools(s);
  registerRecommendTools(s);
  registerDiscoverTools(s);
  registerInfoTools(s);
  registerWriteTools(s);
  registerSocialTools(s);
  registerAnalyticsTools(s);
  registerImportTools(s);
  registerResources(s);
  registerPrompts(s);
  return c;
}

/** Match a URI against an RFC 6570 level-1 template like anilist://list/{type}. */
export function matchTemplate(
  template: string,
  uri: string,
): Record<string, string> | null {
  const names: string[] = [];
  const pattern = template
    .split(/(\{[A-Za-z0-9_]+\})/)
    .map((part) => {
      const m = part.match(/^\{([A-Za-z0-9_]+)\}$/);
      if (m) {
        names.push(m[1]);
        return "([^/]+)";
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  const match = uri.match(new RegExp(`^${pattern}$`));
  if (!match) return null;
  return Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(match[i + 1])]));
}

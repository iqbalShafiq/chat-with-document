import type { UIMessage } from "@anvia/react";

export type WebSourceSummary = {
  url: string;
  title: string;
  content: string;
  source: "web_search" | "web_fetch";
};

const WEB_TOOL_NAMES = new Set(["web_search", "web_fetch"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Collect unique web sources from completed web tool parts in the session's
 * messages. First appearance wins (a repeated search keeps its first spot).
 */
export function collectWebSources(messages: UIMessage[]): WebSourceSummary[] {
  const byUrl = new Map<string, WebSourceSummary>();

  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      if (!WEB_TOOL_NAMES.has(part.toolName)) continue;
      if (part.state !== "output-available") continue;

      const output = isRecord(part.output) ? part.output : {};
      const results = Array.isArray(output.results) ? output.results : [];

      for (const result of results) {
        if (!isRecord(result)) continue;
        const url = asString(result.url);
        if (!url) continue;
        if (byUrl.has(url)) continue;

        const title = asString(result.title) ?? url;
        const content = asString(result.content) ?? "";
        byUrl.set(url, {
          url,
          title,
          content,
          source: "web_search",
        });
      }
    }
  }

  return [...byUrl.values()];
}

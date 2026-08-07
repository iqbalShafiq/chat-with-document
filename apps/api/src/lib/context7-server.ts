import {
  createContext7McpServer,
  type Context7McpServerOptions,
} from "@assingment/agent";
import type { McpServer } from "@anvia/core/mcp";

/**
 * Process-lifetime context7 MCP server connection, shared across chat runs.
 * Connect once per worker process (the connection hands out its tool set),
 * reuse for every run, and degrade to `null` when the remote is unreachable
 * so a context7 outage never breaks chat.
 */

let cached: McpServer | null | undefined;
let pending: Promise<McpServer | null> | null = null;

export function context7Config(): Context7McpServerOptions {
  return {
    ...(process.env.CONTEXT7_API_KEY?.trim()
      ? { apiKey: process.env.CONTEXT7_API_KEY.trim() }
      : {}),
    ...(process.env.CONTEXT7_URL?.trim()
      ? { url: process.env.CONTEXT7_URL.trim() }
      : {}),
  };
}

/** True when context7 is configured via env (even if currently unreachable). */
export function isContext7Configured(): boolean {
  return Boolean(process.env.CONTEXT7_API_KEY?.trim());
}

export async function getContext7McpServer(): Promise<McpServer | null> {
  if (!isContext7Configured()) return null;
  if (cached !== undefined) return cached;
  if (!pending) {
    pending = createContext7McpServer(context7Config())
      .then((server) => {
        cached = server;
        if (server === null) {
          console.warn("[context7] MCP connection failed; running without it");
        }
        return server;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

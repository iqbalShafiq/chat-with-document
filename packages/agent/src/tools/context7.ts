import type { McpServer } from "@anvia/core/mcp";
import { McpClient } from "@anvia/mcp";

/**
 * Context7 MCP bridge: up-to-date, version-specific library documentation.
 * The process owns one v1 Streamable HTTP client. Unreachable configured
 * servers degrade to `null`, allowing chat to continue without Context7.
 */

export const DEFAULT_CONTEXT7_URL = "https://mcp.context7.com/mcp";

export type Context7McpServerOptions = {
  /** Free key from https://context7.com/dashboard for higher rate limits. */
  apiKey?: string;
  url?: string;
};

let client: McpClient | null = null;
let serverPromise: Promise<McpServer | null> | null = null;
let closePromise: Promise<void> | null = null;
let closed = false;

export function createContext7McpServer(
  options: Context7McpServerOptions = {},
): Promise<McpServer | null> {
  if (closed) return Promise.resolve(null);
  if (serverPromise) return serverPromise;

  const apiKey = options.apiKey?.trim();
  client = new McpClient({
    name: "context7",
    transport: {
      type: "streamableHttp",
      url: options.url ?? DEFAULT_CONTEXT7_URL,
      ssrfProtection: "strict",
      ...(apiKey
        ? { headers: { authorization: `Bearer ${apiKey}` } }
        : {}),
    },
  });
  serverPromise = client.connect().catch(() => null);
  return serverPromise;
}

/** Close the process-owned Context7 transport once during shutdown. */
export function closeContext7Mcp(): Promise<void> {
  closed = true;
  closePromise ??= client?.close() ?? Promise.resolve();
  return closePromise;
}

/** Agent guidance on when to prefer context7 (added to instructions). */
export const CONTEXT7_INSTRUCTION = [
  "You have context7 tools (resolve-library-id, query-docs) for up-to-date library and API documentation.",
  "Prefer context7 over web_search for questions about libraries, frameworks, SDKs, and API usage.",
  "First resolve a library name to its context7 library id (e.g. /mongodb/docs, /vercel/next.js), then query the docs with a focused question.",
].join("\n");

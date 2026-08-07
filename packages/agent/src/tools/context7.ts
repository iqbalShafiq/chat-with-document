import { connectMcp, mcp, type McpServer } from "@anvia/core/mcp";

/**
 * Context7 MCP bridge: up-to-date, version-specific library documentation.
 * Connected through @anvia/core's native MCP client (streamable HTTP) so the
 * agent's context7 tools are the official `resolve-library-id` and
 * `query-docs` definitions. Unreachable servers degrade to `null` — the
 * caller logs and runs without them.
 */

export const DEFAULT_CONTEXT7_URL = "https://mcp.context7.com/mcp";

export type Context7McpServerOptions = {
  /** Free key from https://context7.com/dashboard for higher rate limits. */
  apiKey?: string;
  url?: string;
};

export async function createContext7McpServer(
  options: Context7McpServerOptions = {},
): Promise<McpServer | null> {
  const url = options.url ?? DEFAULT_CONTEXT7_URL;
  try {
    return await connectMcp(
      mcp.http({
        name: "context7",
        url,
        ...(options.apiKey?.trim()
          ? {
              transport: {
                requestInit: {
                  headers: {
                    authorization: `Bearer ${options.apiKey.trim()}`,
                  },
                },
              },
            }
          : {}),
      }),
    );
  } catch {
    return null;
  }
}

/** Agent guidance on when to prefer context7 (added to instructions). */
export const CONTEXT7_INSTRUCTION = [
  "You have context7 tools (resolve-library-id, query-docs) for up-to-date library and API documentation.",
  "Prefer context7 over web_search for questions about libraries, frameworks, SDKs, and API usage.",
  "First resolve a library name to its context7 library id (e.g. /mongodb/docs, /vercel/next.js), then query the docs with a focused question.",
].join("\n");

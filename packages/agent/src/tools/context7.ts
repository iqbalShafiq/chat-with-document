import type { McpServer } from "@anvia/core/mcp";
import type { ToolDefinition } from "@anvia/core";
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

/**
 * Versioned JSON-only Context7 contract captured from the configured v1 MCP
 * endpoint on 2026-08-25. Recipe resolution uses this immutable surface and
 * never opens a transport. The worker compares it with the live MCP tools and
 * fails closed if Context7 changes its contract.
 */
export const CONTEXT7_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: "resolve-library-id",
    description:
      "Resolves a package/product name to a Context7-compatible library ID and returns matching libraries.\n\n" +
      "You MUST call this function before 'Query Documentation' tool to obtain a valid Context7-compatible library ID UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.\n\n" +
      "Each result includes:\n- Library ID: Context7-compatible identifier (format: /org/project)\n- Name: Library or package name\n- Description: Short summary\n- Code Snippets: Number of available code examples\n- Source Reputation: Authority indicator (High, Medium, Low, or Unknown)\n- Benchmark Score: Quality indicator (100 is the highest score)\n- Versions: List of versions if available. Use one of those versions if the user provides a version in their query. The format of the version is /org/project/version.\n\n" +
      "For best results, select libraries based on name match, source reputation, snippet coverage, benchmark score, and relevance to your use case.\n\n" +
      "Selection Process:\n1. Analyze the query to understand what library/package the user is looking for\n2. Return the most relevant match based on:\n- Name similarity to the query (exact matches prioritized)\n- Description relevance to the query's intent\n- Documentation coverage (prioritize libraries with higher Code Snippet counts)\n- Source reputation (consider libraries with High or Medium reputation more authoritative)\n- Benchmark Score: Quality indicator (100 is the highest score)\n\n" +
      "Response Format:\n- Return the selected library ID in a clearly marked section\n- Provide a brief explanation for why this library was chosen\n- If multiple good matches exist, acknowledge this but proceed with the most relevant one\n- If no good matches exist, clearly state this and suggest query refinements\n\n" +
      "For ambiguous queries, request clarification before proceeding with a best-guess match.\n\n" +
      "IMPORTANT: Do not call this tool more than 3 times per question. If you cannot find what you need after 3 calls, use the best result you have.",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "What to look up in the library's documentation. This is used to rank library results by relevance to what the user is trying to accomplish. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query.",
        },
        libraryName: {
          type: "string",
          description:
            "Library name to search for and retrieve a Context7-compatible library ID. Use the official library name with proper punctuation — e.g., 'Next.js' instead of 'nextjs', 'Customer.io' instead of 'customerio', 'Three.js' instead of 'threejs'.",
        },
      },
      required: ["query", "libraryName"],
    },
  },
  {
    name: "query-docs",
    description:
      "Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework.\n\n" +
      "You must call 'Resolve Context7 Library ID' tool first to obtain the exact Context7-compatible library ID required to use this tool, UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.\n\n" +
      "Do not call this tool more than 3 times per question.",
    parameters: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        libraryId: {
          type: "string",
          description:
            "Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'.",
        },
        query: {
          type: "string",
          description:
            "What to look up in the library's documentation, scoped to a single concept. Be specific and include relevant details, but keep each query to one topic — if the user's question spans multiple distinct concepts, make a separate call per concept instead of combining them, unless the question is about how the concepts interact. Good: 'How to set up authentication with JWT in Express.js' or 'React useEffect cleanup function examples'. Bad (too vague): 'auth' or 'hooks'. Bad (too broad): 'routing and auth and caching in Next.js'. The query is sent to the Context7 API for processing. Do not include any sensitive or confidential information such as API keys, passwords, credentials, personal data, or proprietary code in your query.",
        },
      },
      required: ["libraryId", "query"],
    },
  },
];

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
    versionNegotiation: { mode: "auto" },
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

import { McpClient } from "@anvia/mcp";
import { validateMcpUrl } from "./service.js";

export type McpTestTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};
export type McpTestResult =
  | { ok: true; tools: McpTestTool[] }
  | { ok: false; error: string };

const TEST_TIMEOUT_MS = 15_000;

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Connection failed";
  const clean = message.replace(/https?:\/\/[^\s]+/g, "[url]").slice(0, 300);
  return `MCP test failed: ${clean}`;
}

export async function testMcpConnection(input: {
  url: string;
  authType: "none" | "bearer";
  token?: string;
}): Promise<McpTestResult> {
  const urlError = validateMcpUrl(input.url);
  if (urlError) return { ok: false, error: urlError };
  const token = input.token?.trim();
  if (input.authType === "bearer" && !token) {
    return { ok: false, error: "Bearer token is required for bearer auth" };
  }
  const client = new McpClient({
    name: "mcp-test",
    transport: {
      type: "streamableHttp",
      url: input.url.trim(),
      ssrfProtection: "strict",
      ...(input.authType === "bearer"
        ? { headers: { authorization: `Bearer ${token}` } }
        : {}),
    },
    versionNegotiation: { mode: "auto" },
  });
  try {
    const server = await Promise.race([
      client.connect(),
      new Promise<null>((_, reject) =>
        setTimeout(
          () => reject(new Error("Timed out after 15s — the server did not answer")),
          TEST_TIMEOUT_MS,
        ),
      ),
    ]);
    if (!server) {
      return { ok: false, error: "Server unreachable — the MCP server did not answer" };
    }
    const tools = await Promise.all(
      server.tools.map(async (tool) => {
        const def = await tool.definition("");
        return {
          name: tool.name,
          description: def.description ?? "",
          parameters: (def.parameters ?? {}) as Record<string, unknown>,
        };
      }),
    );
    return { ok: true, tools };
  } catch (error) {
    return { ok: false, error: boundedError(error) };
  } finally {
    await client.close().catch(() => {});
  }
}

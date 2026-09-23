import { describe, expect, it, vi } from "vitest";
import { testMcpConnection } from "./test-connection.js";

vi.mock("@anvia/mcp", () => {
  class FakeClient {
    static lastArgs: unknown;
    close = vi.fn(async () => {});
    constructor(args: unknown) {
      FakeClient.lastArgs = args;
    }
    async connect() {
      return {
        name: "fake",
        tools: [
          {
            name: "search_docs",
            definition: () => ({
              description: "Search docs",
              parameters: { type: "object" },
            }),
          },
        ],
      };
    }
  }
  return { McpClient: FakeClient };
});

describe("testMcpConnection", () => {
  it("returns the tool list and always closes the client", async () => {
    const result = await testMcpConnection({
      url: "https://mcp.example.com/mcp",
      authType: "none",
    });
    expect(result).toEqual({
      ok: true,
      tools: [
        {
          name: "search_docs",
          description: "Search docs",
          parameters: { type: "object" },
        },
      ],
    });
  });

  it("rejects http without constructing a client", async () => {
    const result = await testMcpConnection({
      url: "http://mcp.example.com/mcp",
      authType: "none",
    });
    expect(result.ok).toBe(false);
  });

  it("sends custom headers with the connection", async () => {
    const { McpClient } = await import("@anvia/mcp");
    const Fake = McpClient as unknown as { lastArgs: unknown };
    await testMcpConnection({
      url: "https://mcp.example.com/mcp",
      authType: "none",
      headers: [{ name: "X-Api-Key", value: "k" }],
    });
    const transport = (Fake.lastArgs as { transport: { headers?: Record<string, string> } }).transport;
    expect(transport.headers).toEqual({ "X-Api-Key": "k" });
  });
});

import { describe, expect, it, vi } from "vitest";
import {
  createMcpServer,
  listMcpServers,
  validateMcpUrl,
} from "./service.js";

function setup() {
  return {
    db: {
      userMcpServer: {
        findMany: vi.fn(
          async (): Promise<Record<string, unknown>[]> => [],
        ),
        findFirst: vi.fn(
          async (): Promise<Record<string, unknown> | null> => null,
        ),
        create: vi.fn(async (a: { data: unknown }) => a.data),
        update: vi.fn(async (a: { data: unknown }) => a.data),
        delete: vi.fn(),
        count: vi.fn(async () => 0),
      },
    },
  };
}

void setup;

describe("mcp crud", () => {
  it("strips credentialsRef when listing", async () => {
    const { db } = setup();
    db.userMcpServer.findMany.mockResolvedValueOnce([
      { id: "m1", name: "ctx", credentialsRef: "secret", url: "https://x.example/mcp" },
    ]);
    const rows = (await listMcpServers(db, "u1")) as Record<string, unknown>[];
    expect(rows[0]).not.toHaveProperty("credentialsRef");
    expect(rows[0]).toHaveProperty("name", "ctx");
  });

  it("refuses when the server cap is reached", async () => {
    const { db } = setup();
    db.userMcpServer.count.mockResolvedValueOnce(5);
    await expect(
      createMcpServer(db, "u1", {
        name: "extra",
        url: "https://mcp.example.com/mcp",
        authType: "none",
      }),
    ).rejects.toThrow("MCP server limit reached");
  });
});

describe("validateMcpUrl", () => {
  it("accepts a public https URL", () => {
    expect(validateMcpUrl("https://mcp.example.com/mcp")).toBeNull();
  });
  it("rejects http before any network call", () => {
    expect(validateMcpUrl("http://mcp.example.com/mcp")).toContain("https");
  });
  it("rejects loopback and private hosts", () => {
    expect(validateMcpUrl("https://127.0.0.1/mcp")).not.toBeNull();
    expect(validateMcpUrl("https://192.168.1.10/mcp")).not.toBeNull();
  });
});

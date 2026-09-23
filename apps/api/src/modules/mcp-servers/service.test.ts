import { describe, expect, it, vi } from "vitest";
import {
  createMcpServer,
  listMcpServers,
  setMcpReview,
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

  it("stores the reviewed tool subset", async () => {
    const { db } = setup();
    db.userMcpServer.findFirst.mockResolvedValueOnce({ id: "m1" });
    await setMcpReview(db, "u1", "m1", {
      allowedTools: ["search_docs"],
      tools: [{ name: "search_docs", description: "Search", parameters: { type: "object" } }],
    });
    expect(db.userMcpServer.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: {
        allowedToolsJson: ["search_docs"],
        toolsJson: [{ name: "search_docs", description: "Search", parameters: { type: "object" } }],
        status: "ok",
        lastError: null,
      },
    });
  });

  it("accepts real-world MCP descriptions up to the recipe ceiling", async () => {
    const { db } = setup();
    db.userMcpServer.findFirst.mockResolvedValueOnce({ id: "m1" });
    const description = "d".repeat(2006);
    await setMcpReview(db, "u1", "m1", {
      allowedTools: ["search_docs"],
      tools: [{ name: "search_docs", description, parameters: {} }],
    });
    expect(db.userMcpServer.update).toHaveBeenCalled();
  });

  it("rejects review tools outside the bounds", async () => {
    const { db } = setup();
    db.userMcpServer.findFirst.mockResolvedValueOnce({ id: "m1" });
    await expect(
      setMcpReview(db, "u1", "m1", {
        allowedTools: ["x".repeat(200)],
        tools: [],
      }),
    ).rejects.toThrow("Tool name");
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

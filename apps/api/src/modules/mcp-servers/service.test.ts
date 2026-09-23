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

  it("rejects allowed tools missing from the reviewed definitions", async () => {
    const { db } = setup();
    db.userMcpServer.findFirst.mockResolvedValueOnce({ id: "m1" });
    await expect(
      setMcpReview(db, "u1", "m1", {
        allowedTools: ["ghost"],
        tools: [{ name: "real", description: "", parameters: {} }],
      }),
    ).rejects.toThrow("ghost");
    expect(db.userMcpServer.update).not.toHaveBeenCalled();
  });

  it("encrypts credentials at rest and decrypts on read", async () => {
    const { db } = setup();
    const { decryptToken } = await import("./credentials.js");
    const { setMcpCredentials, getMcpCredentials } = await import("./service.js");
    db.userMcpServer.findFirst.mockResolvedValue({ id: "m1" });
    await setMcpCredentials(db, "u1", "m1", "super-secret");
    const stored = db.userMcpServer.update.mock.calls[0]?.[0] as {
      data: { credentialsRef: string };
    };
    expect(stored.data.credentialsRef).not.toContain("super-secret");
    db.userMcpServer.findFirst.mockResolvedValueOnce({
      id: "m1",
      credentialsRef: stored.data.credentialsRef,
    });
    await expect(getMcpCredentials(db, "u1", "m1")).resolves.toBe("super-secret");
    expect(decryptToken(stored.data.credentialsRef)).toBe("super-secret");
  });

  it("transparently upgrades legacy plaintext rows", async () => {
    const { db } = setup();
    const { getMcpCredentials } = await import("./service.js");
    db.userMcpServer.findFirst.mockResolvedValueOnce({
      id: "m1",
      credentialsRef: "legacy-plaintext",
    });
    await expect(getMcpCredentials(db, "u1", "m1")).resolves.toBe("legacy-plaintext");
    const stored = db.userMcpServer.update.mock.calls[0]?.[0] as {
      data: { credentialsRef: string };
    };
    expect(stored.data.credentialsRef).not.toBe("legacy-plaintext");
  });

  it("validates custom headers and rejects the authorization header", async () => {
    const { db } = setup();
    const { setMcpHeaders, getMcpHeaders } = await import("./service.js");
    db.userMcpServer.findFirst.mockResolvedValue({ id: "m1" });
    await expect(
      setMcpHeaders(db, "u1", "m1", [{ name: "Authorization", value: "x" }]),
    ).rejects.toThrow("authorization");
    await expect(
      setMcpHeaders(db, "u1", "m1", [{ name: "bad name!", value: "x" }]),
    ).rejects.toThrow("Header name");
    await setMcpHeaders(db, "u1", "m1", [{ name: "X-Api-Key", value: "k" }]);
    const stored = db.userMcpServer.update.mock.calls.at(-1)?.[0] as {
      data: { headersRef: string };
    };
    db.userMcpServer.findFirst.mockResolvedValueOnce({
      id: "m1",
      headersRef: stored.data.headersRef,
    });
    await expect(getMcpHeaders(db, "u1", "m1")).resolves.toEqual([
      { name: "X-Api-Key", value: "k" },
    ]);
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

  it("tells the user only public https hosts are allowed", () => {
    expect(validateMcpUrl("http://mcp.example.com/mcp")).toContain("https");
    expect(validateMcpUrl("https://10.0.0.5/mcp")).toContain("https");
  });

  it("blocks unspecified, ipv6 loopback, mapped, dotted, and malformed numeric hosts", () => {
    expect(validateMcpUrl("https://0.0.0.0/mcp")).not.toBeNull();
    expect(validateMcpUrl("https://[::1]/mcp")).not.toBeNull();
    expect(validateMcpUrl("https://[::]/mcp")).not.toBeNull();
    expect(validateMcpUrl("https://[::ffff:127.0.0.1]/mcp")).not.toBeNull();
    expect(validateMcpUrl("https://localhost./mcp")).not.toBeNull();
    expect(validateMcpUrl("https://999.1.1.1/mcp")).not.toBeNull();
  });
});

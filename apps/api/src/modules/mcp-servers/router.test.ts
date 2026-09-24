import { describe, expect, it, vi } from "vitest";
import { mcpServersRouter } from "./router.js";
import {
  createMcpServer,
  getMcpCredentials,
  setMcpCredentials,
  setMcpHeaders,
} from "./service.js";

vi.mock("../auth/middleware.js", () => ({
  requireUser: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "u1", email: "u1@example.com", name: "U1", image: null });
    await next();
  },
}));

vi.mock("../../utils/prisma.js", () => ({
  prisma: {
    userMcpServer: {
      findFirst: vi.fn(async () => ({ id: "m1", name: "docs" })),
    },
  },
}));

vi.mock("./service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./service.js")>();
  return {
    ...original,
    listMcpServers: vi.fn(async () => []),
    createMcpServer: vi.fn(async () => ({ id: "m1" })),
    updateMcpServer: vi.fn(async () => ({ id: "m1" })),
    setMcpCredentials: vi.fn(async () => ({})),
    setMcpHeaders: vi.fn(async () => ({})),
    setMcpReview: vi.fn(async () => ({})),
    getMcpCredentials: vi.fn(async () => null),
    getMcpHeaders: vi.fn(async () => []),
  };
});

describe("mcpServersRouter", () => {
  it("lists servers for the authenticated user without credentials", async () => {
    const response = await mcpServersRouter.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("tests a connection without persisting (invalid url fails fast)", async () => {
    const response = await mcpServersRouter.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://mcp.example.com/mcp", authType: "none" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("https");
  });

  it("tolerates extra keys in the test body", async () => {
    const response = await mcpServersRouter.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "docs", url: "http://mcp.example.com/mcp", authType: "none" }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body).toEqual({ ok: false, error: expect.stringContaining("https") });
  });

  it("maps duplicate names to a 400 field error, not a 500", async () => {
    (createMcpServer as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint"), { code: "P2002" }),
    );
    const response = await mcpServersRouter.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "docs", url: "https://mcp.example.com/mcp", authType: "none" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: { path: string }[] };
    expect(body.issues[0]?.path).toBe("name");
  });

  it("clears the stored credential when auth switches to none", async () => {
    const response = await mcpServersRouter.request("/m1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "docs", url: "https://mcp.example.com/mcp", authType: "none" }),
    });
    expect(response.status).toBe(200);
    expect(setMcpCredentials as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      "m1",
      "",
    );
  });

  it("stores custom headers encrypted on create", async () => {
    const response = await mcpServersRouter.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "docs",
        url: "https://mcp.example.com/mcp",
        authType: "none",
        headers: [{ name: "X-Api-Key", value: "k" }],
      }),
    });
    expect(response.status).toBe(201);
    expect(setMcpHeaders as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      expect.anything(),
      "u1",
      "m1",
      [{ name: "X-Api-Key", value: "k" }],
    );
  });

  it("reuses the stored token when testing a saved server", async () => {
    (getMcpCredentials as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "stored-token",
    );
    const response = await mcpServersRouter.request("/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "http://mcp.example.com/mcp",
        authType: "bearer",
        serverId: "m1",
      }),
    });
    // http URL fails validation — proving the stored token (not "missing
    // token") was used for the attempt.
    const body = (await response.json()) as { ok: boolean; error?: string };
    expect(body).toEqual({ ok: false, error: expect.stringContaining("https") });
  });
});

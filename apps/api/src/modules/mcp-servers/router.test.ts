import { describe, expect, it, vi } from "vitest";
import { mcpServersRouter } from "./router.js";

vi.mock("../auth/middleware.js", () => ({
  requireUser: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "u1", email: "u1@example.com", name: "U1", image: null });
    await next();
  },
}));

vi.mock("./service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./service.js")>();
  return {
    ...original,
    listMcpServers: vi.fn(async () => []),
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
});

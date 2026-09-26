import { describe, expect, it, vi } from "vitest";
import { artifactsRouter } from "./router.js";

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
    listArtifacts: vi.fn(async () => ({ items: [] })),
    resolveSessionScope: vi.fn(async () => null),
  };
});

describe("artifactsRouter", () => {
  it("lists artifacts scoped to the session project", async () => {
    const response = await artifactsRouter.request("/?type=document&sessionId=s1");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
  });

  it("rejects unknown artifact type", async () => {
    const response = await artifactsRouter.request("/?type=nope");
    expect(response.status).toBe(400);
  });
});

import { describe, expect, it, vi } from "vitest";
import { skillsRouter } from "./router.js";
import { SkillInputError, createSkill } from "./service.js";

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
    listSkills: vi.fn(async () => []),
    createSkill: vi.fn(async () => {
      throw new SkillInputError([{ path: "name", message: "bad" }]);
    }),
  };
});

describe("skillsRouter", () => {
  it("lists skills for the authenticated user", async () => {
    const response = await skillsRouter.request("/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([]);
  });

  it("maps validation failures to 400 with issues", async () => {
    const response = await skillsRouter.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x", description: "d", bodyMd: "b" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: unknown[] };
    expect(body.issues).toHaveLength(1);
  });

  it("maps duplicate names to a 400 field error, not a 500", async () => {
    (createSkill as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint"), { code: "P2002" }),
    );
    const response = await skillsRouter.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "brief", description: "d", bodyMd: "---\nname: brief\ndescription: d\n---\nb" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { issues: { path: string }[] };
    expect(body.issues[0]?.path).toBe("name");
  });
});

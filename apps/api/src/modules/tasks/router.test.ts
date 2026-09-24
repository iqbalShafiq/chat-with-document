import { describe, expect, it, vi } from "vitest";
import { tasksRouter } from "./router.js";

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
    listTasks: vi.fn(async () => ({ items: [] })),
    createTask: vi.fn(async () => ({ id: "t1", title: "review", status: "inbox" })),
    updateTask: vi.fn(async () => ({ id: "t1", title: "review", status: "done" })),
  };
});

describe("tasksRouter", () => {
  it("creates a task in session scope", async () => {
    const response = await tasksRouter.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", title: "review" }),
    });
    expect(response.status).toBe(201);
  });

  it("updates status instead of duplicating", async () => {
    const response = await tasksRouter.request("/t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { status: string }).status).toBe("done");
  });

  it("rejects empty titles", async () => {
    const response = await tasksRouter.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s1", title: " " }),
    });
    expect(response.status).toBe(400);
  });
});

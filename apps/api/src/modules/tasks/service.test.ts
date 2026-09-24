import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/prisma.js", () => ({
  prisma: {
    chatSession: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (where.id === "sA") return { projectId: "pA" };
        if (where.id === "sB") return { projectId: "pB" };
        return null;
      }),
    },
    workspaceTask: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id === "t1" && where.projectId === "pA") return { id: "t1" };
        return null;
      }),
      update: vi.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        title: "t",
        status: "done",
      })),
    },
  },
}));

import { updateTask } from "./service.js";

describe("updateTask scope", () => {
  it("updates within the same project scope", async () => {
    await expect(
      updateTask({ userId: "u1", sessionId: "sA", id: "t1", status: "done" }),
    ).resolves.toMatchObject({ id: "t1", status: "done" });
  });

  it("404s across projects instead of mutating", async () => {
    await expect(
      updateTask({ userId: "u1", sessionId: "sB", id: "t1", status: "done" }),
    ).rejects.toThrow("Task not found");
  });

  it("404s for unknown sessions", async () => {
    await expect(
      updateTask({ userId: "u1", sessionId: "nope", id: "t1", status: "done" }),
    ).rejects.toThrow("Session not found");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

type StoredTask = {
  id: string;
  title: string;
  status: string;
  description: string | null;
  subtasks: { id: string; title: string; done: boolean }[];
  projectId: string | null;
};

const taskStore = new Map<string, StoredTask>();

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
        const task = taskStore.get(where.id as string);
        if (!task) return null;
        if (where.projectId !== undefined && task.projectId !== where.projectId) return null;
        return { id: task.id, description: task.description, subtasks: task.subtasks };
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const task = taskStore.get(where.id)!;
          const next = { ...task, ...data };
          taskStore.set(where.id, next as StoredTask);
          return {
            id: next.id,
            title: next.title,
            status: next.status,
            description: next.description,
            subtasks: next.subtasks,
          };
        },
      ),
    },
  },
}));

import { updateTask } from "./service.js";
import { prisma } from "../../utils/prisma.js";

function seedTask() {
  taskStore.set("t1", {
    id: "t1",
    title: "Trip Bandung",
    status: "inbox",
    description: null,
    subtasks: [],
    projectId: "pA",
  });
}

beforeEach(() => {
  taskStore.clear();
  seedTask();
});

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

describe("updateTask subtasks", () => {
  it("adds subtasks and reports progress", async () => {
    const added = (await updateTask({
      userId: "u1",
      sessionId: "sA",
      id: "t1",
      addSubtasks: ["Booking hotel", "Beli tiket"],
    })) as unknown as { subtasks: { id: string; title: string; done: boolean }[] };
    expect(added.subtasks.map((s) => s.title)).toEqual(["Booking hotel", "Beli tiket"]);
    expect(added.subtasks.every((s) => s.done === false)).toBe(true);
  });

  it("toggles a subtask and completes the parent explicitly", async () => {
    const added = (await updateTask({
      userId: "u1",
      sessionId: "sA",
      id: "t1",
      addSubtasks: ["Booking hotel"],
    })) as unknown as { subtasks: { id: string }[] };
    const subId = added.subtasks[0]!.id;
    const toggled = (await updateTask({
      userId: "u1",
      sessionId: "sA",
      id: "t1",
      toggleSubtasks: [{ id: subId, done: true }],
    })) as unknown as { subtasks: { done: boolean }[] };
    expect(toggled.subtasks[0]!.done).toBe(true);
    await expect(
      updateTask({ userId: "u1", sessionId: "sA", id: "t1", status: "done" }),
    ).resolves.toMatchObject({ status: "done" });
  });

  it("rejects unknown subtask ids loudly", async () => {
    await expect(
      updateTask({ userId: "u1", sessionId: "sA", id: "t1", toggleSubtasks: [{ id: "nope", done: true }] }),
    ).rejects.toThrow("Subtask not found");
  });

  it("saves a description", async () => {
    await expect(
      updateTask({ userId: "u1", sessionId: "sA", id: "t1", description: "Berangkat Jumat pagi" }),
    ).resolves.toMatchObject({ id: "t1" });
    expect(taskStore.get("t1")!.description).toBe("Berangkat Jumat pagi");
  });

  it("removes a subtask", async () => {
    const added = (await updateTask({
      userId: "u1",
      sessionId: "sA",
      id: "t1",
      addSubtasks: ["Batalkan"],
    })) as unknown as { subtasks: { id: string }[] };
    const removed = (await updateTask({
      userId: "u1",
      sessionId: "sA",
      id: "t1",
      removeSubtasks: [added.subtasks[0]!.id],
    })) as unknown as { subtasks: unknown[] };
    expect(removed.subtasks).toEqual([]);
  });
});

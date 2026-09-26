import { describe, expect, it } from "vitest";
import { WORKSPACE_TOOL_DEFINITIONS, createWorkspaceManageTools } from "./workspace-tools.js";

describe("WORKSPACE_TOOL_DEFINITIONS", () => {
  it("exposes manage_tasks and manage_schedules", () => {
    expect(WORKSPACE_TOOL_DEFINITIONS.map((d) => d.name).sort()).toEqual(
      ["manage_schedules", "manage_tasks"].sort(),
    );
  });
});

describe("createWorkspaceManageTools tasks", () => {
  function tools() {
    const store = new Map<string, { id: string; subtasks: { id: string; done: boolean }[] }>();
    return createWorkspaceManageTools({
      tasks: {
        list: async () => [],
        create: async ({ title, addSubtasks }) => {
          const id = "t1";
          store.set(id, {
            id,
            subtasks: (addSubtasks ?? []).map((t, i) => ({ id: `s${i}`, title: t, done: false })),
          });
          return { id };
        },
        update: async ({ id, toggleSubtasks }) => {
          const task = store.get(id)!;
          for (const t of toggleSubtasks ?? []) {
            const sub = task.subtasks.find((s) => s.id === t.id);
            if (sub) sub.done = t.done;
          }
          return { id, subtasks: task.subtasks };
        },
      },
      schedules: {
        list: async () => [],
        create: async () => ({ id: "sched-1" }),
        cancel: async () => ({ ok: true }),
      },
    });
  }

  it("creates a task with subtasks and toggles one done", async () => {
    const [manageTasks] = tools();
    const created = (await manageTasks!.call({
      action: "create",
      title: "Trip Bandung",
      addSubtasks: ["Booking hotel", "Beli tiket"],
    })) as unknown as { id: string };
    expect(created.id).toBe("t1");
    const updated = (await manageTasks!.call({
      action: "update",
      id: "t1",
      toggleSubtasks: [{ id: "s0", done: true }],
    })) as unknown as { subtasks: { id: string; done: boolean }[] };
    expect(updated.subtasks.find((s) => s.id === "s0")?.done).toBe(true);
    expect(updated.subtasks.find((s) => s.id === "s1")?.done).toBe(false);
  });
});

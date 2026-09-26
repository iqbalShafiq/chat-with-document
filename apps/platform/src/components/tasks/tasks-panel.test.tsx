// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listTasks: vi.fn(),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
  createTask: vi.fn(),
  listSchedules: vi.fn(),
  cancelSchedule: vi.fn(),
}));

vi.mock("#/lib/api-artifacts", () => ({
  listTasks: mocks.listTasks,
  updateTask: mocks.updateTask,
  deleteTask: mocks.deleteTask,
  createTask: mocks.createTask,
  listSchedules: mocks.listSchedules,
  cancelSchedule: mocks.cancelSchedule,
}));

import { SchedulesPanel } from "./schedules-panel";
import { TasksPanel } from "./tasks-panel";

// jsdom has no <dialog> methods; ConfirmDialog uses showModal().
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
  this.removeAttribute("open");
};

const task = {
  id: "t1",
  title: "Rencana",
  status: "inbox" as const,
  description: null,
  subtasks: [],
  sourceSessionId: null,
  dueAt: null,
  createdAt: "2026-09-26T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listTasks.mockResolvedValue([task]);
  mocks.updateTask.mockResolvedValue(task);
  mocks.listSchedules.mockResolvedValue([
    {
      id: "s1",
      title: "Brief",
      freq: "once",
      nextRunAt: "2026-09-27T00:00:00.000Z",
      status: "active",
      createdAt: "2026-09-26T00:00:00.000Z",
      prompt: "x",
      projectId: null,
    },
  ]);
  mocks.cancelSchedule.mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("tasks panel failure feedback", () => {
  it("surfaces a failed status update instead of failing silently", async () => {
    mocks.updateTask.mockRejectedValueOnce(new Error("Update failed"));
    render(<TasksPanel sessionId="s1" />);
    const doing = await screen.findByRole("button", { name: /mark rencana doing/i });
    await userEvent.click(doing);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Update failed");
  });

  it("exposes a doing control so the middle status is reachable", async () => {
    render(<TasksPanel sessionId="s1" />);
    const doing = await screen.findByRole("button", { name: /mark rencana doing/i });
    await userEvent.click(doing);
    await waitFor(() =>
      expect(mocks.updateTask).toHaveBeenCalledWith("t1", { sessionId: "s1", status: "doing" }),
    );
  });
});

describe("schedules panel failure feedback", () => {
  it("surfaces a failed cancel instead of failing silently", async () => {
    mocks.cancelSchedule.mockRejectedValueOnce(new Error("Cancel failed"));
    render(<SchedulesPanel sessionId="s1" />);
    await userEvent.click(await screen.findByRole("button", { name: /cancel brief/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Cancel failed");
  });
});

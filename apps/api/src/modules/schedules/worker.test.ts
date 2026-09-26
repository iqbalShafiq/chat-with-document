import { describe, expect, it, vi } from "vitest";
import { runWorkspaceSchedule, type ScheduleExecutionDeps } from "./worker.js";

type ScheduleRow = {
  id: string;
  userId: string;
  projectId: string | null;
  sessionId: string | null;
  prompt: string;
  freq: string;
  status: string;
  attempts: number;
};

function schedule(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: "sched-1",
    userId: "u1",
    projectId: null,
    sessionId: "session-1",
    prompt: "Buat ringkasan harian",
    freq: "once",
    status: "active",
    attempts: 0,
    ...overrides,
  };
}

function deps(overrides: Partial<ScheduleExecutionDeps> = {}): {
  deps: ScheduleExecutionDeps;
  updateSchedule: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
  startRun: ReturnType<typeof vi.fn>;
} {
  const updateSchedule = vi.fn(async () => undefined);
  const enqueue = vi.fn(async () => undefined);
  const startRun = vi.fn(async () => ({ status: "started" as const, streamId: "stream-1" }));
  const base: ScheduleExecutionDeps = {
    loadSchedule: async () => schedule(),
    updateSchedule,
    startRun,
    enqueue,
    now: () => new Date("2026-09-26T09:00:00.000Z"),
    ...overrides,
  };
  return { deps: base, updateSchedule, enqueue, startRun };
}

describe("runWorkspaceSchedule", () => {
  it("executes a due once-schedule and marks it done", async () => {
    const t = deps();
    const out = await runWorkspaceSchedule({ scheduleId: "sched-1", userId: "u1" }, t.deps);
    expect(t.startRun).toHaveBeenCalledWith({
      userId: "u1",
      sessionId: "session-1",
      prompt: "Buat ringkasan harian",
    });
    expect(t.updateSchedule).toHaveBeenCalledWith(
      "sched-1",
      expect.objectContaining({ status: "done", lastError: null, attempts: 0 }),
    );
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, rescheduled: false });
  });

  it("reschedules a recurring schedule after a successful run", async () => {
    const t = deps({ loadSchedule: async () => schedule({ freq: "daily" }) });
    const out = await runWorkspaceSchedule({ scheduleId: "sched-1", userId: "u1" }, t.deps);
    expect(t.updateSchedule).toHaveBeenCalledWith(
      "sched-1",
      expect.objectContaining({ lastRunAt: new Date("2026-09-26T09:00:00.000Z") }),
    );
    expect(t.enqueue).toHaveBeenCalledTimes(1);
    const [jobId, , delayMs] = t.enqueue.mock.calls[0] as unknown as [string, unknown, number];
    expect(String(jobId)).toContain("sched-1");
    expect(delayMs).toBe(24 * 60 * 60 * 1000);
    expect(out.rescheduled).toBe(true);
  });

  it("retries later without burning attempts when the session is busy", async () => {
    const t = deps({ startRun: async () => ({ status: "busy" }) });
    const out = await runWorkspaceSchedule({ scheduleId: "sched-1", userId: "u1" }, t.deps);
    expect(t.updateSchedule).toHaveBeenCalledWith(
      "sched-1",
      expect.not.objectContaining({ attempts: 1 }),
    );
    expect(t.enqueue).toHaveBeenCalledTimes(1);
    expect(out.rescheduled).toBe(true);
  });

  it("counts failures and dead-letters after three attempts", async () => {
    const failing = async () => ({ status: "failed" as const, message: "queue down" });
    const first = deps({ startRun: failing });
    await runWorkspaceSchedule({ scheduleId: "sched-1", userId: "u1" }, first.deps);
    expect(first.updateSchedule).toHaveBeenCalledWith(
      "sched-1",
      expect.objectContaining({ attempts: 1, lastError: "queue down" }),
    );
    expect(first.enqueue).toHaveBeenCalledTimes(1);

    const third = deps({
      loadSchedule: async () => schedule({ attempts: 2 }),
      startRun: failing,
    });
    const out = await runWorkspaceSchedule({ scheduleId: "sched-1", userId: "u1" }, third.deps);
    expect(third.updateSchedule).toHaveBeenCalledWith(
      "sched-1",
      expect.objectContaining({ attempts: 3, status: "failed", lastError: "queue down" }),
    );
    expect(third.enqueue).not.toHaveBeenCalled();
    expect(out.rescheduled).toBe(false);
  });

  it("fails the schedule when its session is gone", async () => {
    const t = deps({ startRun: async () => ({ status: "session-missing" }) });
    await runWorkspaceSchedule({ scheduleId: "sched-1", userId: "u1" }, t.deps);
    expect(t.updateSchedule).toHaveBeenCalledWith(
      "sched-1",
      expect.objectContaining({ attempts: 1, lastError: "Session not found" }),
    );
  });

  it("does nothing for cancelled or done schedules", async () => {
    for (const status of ["cancelled", "done", "failed"]) {
      const t = deps({ loadSchedule: async () => schedule({ status }) });
      const out = await runWorkspaceSchedule({ scheduleId: "sched-1", userId: "u1" }, t.deps);
      expect(t.startRun).not.toHaveBeenCalled();
      expect(out).toMatchObject({ ok: true, rescheduled: false });
    }
  });
});

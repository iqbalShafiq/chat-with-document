import { describe, expect, it } from "vitest";
import { nextRunAt, scheduleFollowUpJobId, scheduleJobId, scheduleRetryJobId } from "./queue.js";

describe("schedules queue", () => {
  it("builds stable job ids without the reserved ':' separator", () => {
    // BullMQ rejects custom ids containing ':' (Job.validateOptions).
    expect(scheduleJobId("s1")).toBe("workspace-schedule-s1");
    expect(scheduleRetryJobId("s1", 123)).toBe("workspace-schedule-s1-retry-123");
    expect(scheduleFollowUpJobId("s1", 456)).toBe("workspace-schedule-s1-next-456");
    for (const id of [
      scheduleJobId("s1"),
      scheduleRetryJobId("s1", 123),
      scheduleFollowUpJobId("s1", 456),
    ]) {
      expect(id.includes(":")).toBe(false);
    }
  });
  it("computes daily and weekly delays", () => {
    const from = new Date("2026-09-24T00:00:00Z");
    expect(nextRunAt("daily", from).getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(nextRunAt("weekly", from).getTime() - from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

import { describe, expect, it } from "vitest";
import { nextRunAt, scheduleJobId } from "./queue.js";

describe("schedules queue", () => {
  it("builds stable job ids", () => {
    expect(scheduleJobId("s1")).toBe("workspace-schedule:s1");
  });
  it("computes daily and weekly delays", () => {
    const from = new Date("2026-09-24T00:00:00Z");
    expect(nextRunAt("daily", from).getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(nextRunAt("weekly", from).getTime() - from.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

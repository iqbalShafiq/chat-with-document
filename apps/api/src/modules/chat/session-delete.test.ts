import { describe, expect, it } from "vitest";
import { buildSessionSnapshotText } from "./session-snapshot.js";

describe("buildSessionSnapshotText", () => {
  it("keeps only the last 12 messages", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
      text: `message ${i}`,
    }));
    const out = buildSessionSnapshotText(rows);
    expect(out).toContain("message 4");
    expect(out).not.toContain("message 0");
  });

  it("drops empty messages and caps total chars", () => {
    const out = buildSessionSnapshotText([
      { createdAt: new Date(), text: "   " },
      { createdAt: new Date(), text: "x".repeat(10_000) },
    ]);
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out).toMatch(/\[.*\] x+…/);
  });
});

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

  it("reserves separator chars so 11 short messages plus 1 huge hit exactly 8000", () => {
    const rows = [
      ...Array.from({ length: 11 }, (_, i) => ({
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
        text: `message ${i}`,
      })),
      { createdAt: new Date(Date.UTC(2026, 0, 12)), text: "x".repeat(10_000) },
    ];
    const out = buildSessionSnapshotText(rows);
    expect(out.length).toBe(8000);
  });

  it("returns empty string for no rows", () => {
    expect(buildSessionSnapshotText([])).toBe("");
  });

  it("returns empty string when all texts are empty", () => {
    expect(
      buildSessionSnapshotText([
        { createdAt: new Date(), text: "   " },
        { createdAt: new Date(), text: "" },
        { createdAt: new Date(), text: "\n\t" },
      ]),
    ).toBe("");
  });

  it("keeps all 12 newest and drops the oldest of 13", () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
      text: `message ${i}`,
    }));
    const out = buildSessionSnapshotText(rows);
    expect(out).toContain("message 12");
    expect(out).toContain("message 1");
    expect(out).not.toContain("message 0");
  });

  it("collapses whitespace in message text", () => {
    const out = buildSessionSnapshotText([
      { createdAt: new Date(), text: "line1\n\n  line2" },
    ]);
    expect(out).toContain("line1 line2");
  });

  it("ignores trailing empty rows when keeping the last 12", () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) => ({
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
        text: `message ${i}`,
      })),
      { createdAt: new Date(), text: " " },
      { createdAt: new Date(), text: "" },
    ];
    const out = buildSessionSnapshotText(rows);
    expect(out).toContain("message 11");
    expect(out).toContain("message 0");
  });

  it("clips emoji messages by UTF-16 units without breaking surrogate pairs", () => {
    const out = buildSessionSnapshotText([
      { createdAt: new Date(), text: "😀".repeat(10_000) },
    ]);
    expect(out.length).toBeLessThanOrEqual(8000);
    for (const ch of Array.from(out)) {
      if (ch.length === 2) expect(ch).toBe("😀");
    }
  });

  it("keeps the newest messages when the budget runs out", () => {
    const out = buildSessionSnapshotText([
      { createdAt: new Date(), text: "old message" },
      { createdAt: new Date(Date.now() + 60_000), text: "mid message" },
      { createdAt: new Date(Date.now() + 120_000), text: "z".repeat(10_000) },
    ]);
    expect(out).toContain("zzz");
    expect(out).not.toContain("old message");
  });
});

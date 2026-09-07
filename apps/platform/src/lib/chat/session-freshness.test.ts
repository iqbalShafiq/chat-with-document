import { describe, expect, it } from "vitest";
import {
  blocksDestructiveSessionAction,
  sessionFreshnessFromCount,
} from "./session-freshness";

describe("sessionFreshnessFromCount", () => {
  it("is stale only when the server has more messages than this view", () => {
    expect(sessionFreshnessFromCount(3, 2)).toBe("stale");
    expect(sessionFreshnessFromCount(2, 2)).toBe("fresh");
    expect(sessionFreshnessFromCount(1, 2)).toBe("fresh");
  });

  it("rejects a non-integer count instead of guessing freshness", () => {
    expect(() => sessionFreshnessFromCount(1.5, 1)).toThrow(/invalid/);
    expect(() => sessionFreshnessFromCount(1, Number.NaN)).toThrow(/invalid/);
  });
});

describe("blocksDestructiveSessionAction", () => {
  it("blocks truncate/resubmit unless freshness is proven", () => {
    expect(blocksDestructiveSessionAction("fresh")).toBe(false);
    expect(blocksDestructiveSessionAction("stale")).toBe(true);
    expect(blocksDestructiveSessionAction("unknown")).toBe(true);
  });
});

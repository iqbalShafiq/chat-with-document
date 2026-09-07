import { describe, expect, it } from "vitest";
import { findEmptyNewChat, type SessionSummary } from "./session-history";

function row(
  sessionId: string,
  title: string,
): SessionSummary {
  return {
    sessionId,
    projectId: null,
    title,
    updatedAt: "2026-08-27T00:00:00.000Z",
    unread: false,
  };
}

describe("findEmptyNewChat", () => {
  it("skips empty drafts that still have an active run", () => {
    const busy = row("busy-empty", "New chat");
    const free = row("free-empty", "New chat");
    const filled = row("filled", "Hello");

    expect(findEmptyNewChat([busy, free, filled])).toEqual(busy);
    expect(
      findEmptyNewChat([busy, free, filled], new Set(["busy-empty"])),
    ).toEqual(free);
    expect(
      findEmptyNewChat([busy, filled], new Set(["busy-empty"])),
    ).toBeNull();
  });
});

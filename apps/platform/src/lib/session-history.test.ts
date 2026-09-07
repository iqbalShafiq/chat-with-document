import { describe, expect, it } from "vitest";
import {
  findEmptyNewChat,
  isShareLinkStale,
  type SessionSummary,
} from "./session-history";

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

describe("isShareLinkStale", () => {
  it("marks the link stale when the chat changed after the link", () => {
    expect(
      isShareLinkStale({
        linkCreatedAt: "2026-08-27T10:00:00.000Z",
        sessionUpdatedAt: "2026-08-27T10:05:00.000Z",
      }),
    ).toBe(true);
  });

  it("keeps the link fresh when nothing changed after minting", () => {
    expect(
      isShareLinkStale({
        linkCreatedAt: "2026-08-27T10:05:00.000Z",
        sessionUpdatedAt: "2026-08-27T10:05:00.000Z",
      }),
    ).toBe(false);
    expect(
      isShareLinkStale({
        linkCreatedAt: "2026-08-27T10:05:00.000Z",
        sessionUpdatedAt: "2026-08-27T10:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("stays fresh when either timestamp is missing or invalid", () => {
    expect(
      isShareLinkStale({ linkCreatedAt: null, sessionUpdatedAt: null }),
    ).toBe(false);
    expect(
      isShareLinkStale({
        linkCreatedAt: "not-a-date",
        sessionUpdatedAt: "2026-08-27T10:05:00.000Z",
      }),
    ).toBe(false);
  });
});

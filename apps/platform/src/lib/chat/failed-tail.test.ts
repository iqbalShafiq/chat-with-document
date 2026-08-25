import { describe, expect, it } from "vitest";
import { failedTailTruncate } from "./failed-tail";

describe("failedTailTruncate", () => {
  it("returns the failed user id and prefix count", () => {
    expect(
      failedTailTruncate([
        { role: "user", metadata: { clientMessageId: "u1" } },
        { role: "assistant", metadata: { clientMessageId: "a1" } },
        { role: "user", metadata: { clientMessageId: "failed-user" } },
        { role: "assistant", metadata: { kind: "error" } },
      ]),
    ).toEqual({
      clientMessageId: "failed-user",
      expectedPrefixMessageCount: 2,
    });
  });

  it("ignores a successful tail", () => {
    expect(
      failedTailTruncate([
        { role: "user", metadata: { clientMessageId: "u1" } },
        { role: "assistant", metadata: {} },
      ]),
    ).toBeNull();
  });

  it("ignores a failed assistant without a client-tagged user prompt", () => {
    expect(
      failedTailTruncate([
        { role: "user", metadata: {} },
        { role: "assistant", metadata: { kind: "error" } },
      ]),
    ).toBeNull();
  });
});

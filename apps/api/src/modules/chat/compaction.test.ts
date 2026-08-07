import { describe, expect, it } from "vitest";
import type { Message } from "@anvia/core";
import {
  buildCompactedView,
  findCompactionBoundary,
  groupMemoryMessages,
  truncateGroupsToTarget,
  type CompactionSegment,
} from "./compaction.js";
import { estimateMessagesTokens } from "../../lib/token-estimate.js";

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] } as Message;
}

function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] } as Message;
}

function assistantWithToolCall(id: string): Message {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_call",
        id,
        function: { name: "search_docs", arguments: "{}" },
      },
    ],
  } as Message;
}

function toolResult(id: string): Message {
  return {
    role: "tool",
    content: [
      {
        type: "tool_result",
        id,
        content: [{ type: "text", text: "result payload" }],
      },
    ],
  } as Message;
}

function systemMessage(text: string): Message {
  return { role: "system", content: text } as Message;
}

function summaryMessage(text: string): Message {
  return { role: "system", content: text, metadata: { kind: "summary" } } as Message;
}

function row(position: number, message: Message): { position: number; message: Message } {
  return { position, message };
}

function summarized(upToPosition: number, summary: string): CompactionSegment {
  return { kind: "summarized", upToPosition, summary, createdAt: "2026-08-07T00:00:00.000Z" };
}

function dropped(upToPosition: number): CompactionSegment {
  return { kind: "dropped", upToPosition, createdAt: "2026-08-07T00:00:00.000Z" };
}

function turns(count: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(user(`user message ${i}`));
    messages.push(assistant(`assistant reply ${i}`));
  }
  return messages;
}

const BIG = "x".repeat(400); // 100 tokens; message overhead 4 => 104 per message

describe("groupMemoryMessages", () => {
  it("makes system messages singletons", () => {
    const groups = groupMemoryMessages([
      systemMessage("a"),
      systemMessage("b"),
      user("hi"),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(["system", "system", "user"]);
    expect(groups[0]!.messages).toHaveLength(1);
    expect(groups[1]!.messages).toHaveLength(1);
  });

  it("starts a new group for each user message", () => {
    const groups = groupMemoryMessages([user("a"), user("b"), user("c")]);
    expect(groups.map((group) => group.kind)).toEqual(["user", "user", "user"]);
  });

  it("keeps tool-call assistant and its tool results atomic in one group", () => {
    const groups = groupMemoryMessages([
      user("a"),
      assistantWithToolCall("c1"),
      toolResult("c1"),
      toolResult("c1"),
      assistant("done"),
    ]);
    expect(groups.map((group) => group.kind)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(groups[1]!.messages).toHaveLength(3);
    expect(groups[1]!.messages[1]).toMatchObject({ role: "tool" });
  });

  it("gives plain assistant text its own group", () => {
    const groups = groupMemoryMessages([user("a"), assistant("reply")]);
    expect(groups.map((group) => group.kind)).toEqual(["user", "assistant"]);
    expect(groups[1]!.messages).toHaveLength(1);
  });

  it("attaches orphan tool messages to the previous group", () => {
    const groups = groupMemoryMessages([user("a"), toolResult("c1")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("user");
    expect(groups[0]!.messages).toHaveLength(2);
  });

  it("creates a tool group for a leading orphan tool message", () => {
    const groups = groupMemoryMessages([toolResult("c1")]);
    expect(groups[0]!.kind).toBe("tool");
    expect(groups[0]!.messages).toHaveLength(1);
  });
});

describe("findCompactionBoundary", () => {
  it("keeps the last keepTurns user turns and everything after them", () => {
    const groups = groupMemoryMessages(turns(10));
    expect(groups).toHaveLength(20);

    const boundary = findCompactionBoundary(groups, 8);
    expect(boundary).toBe(4);

    const kept = groups.slice(boundary);
    expect(kept.filter((group) => group.kind === "user")).toHaveLength(8);
    expect(groups.slice(0, boundary).every((group) => group.kind !== "user")).toBe(
      false,
    );
  });

  it("returns 0 when there are fewer turns than keepTurns", () => {
    const groups = groupMemoryMessages(turns(5));
    expect(findCompactionBoundary(groups, 8)).toBe(0);
  });

  it("returns 0 for an empty group list", () => {
    expect(findCompactionBoundary([], 8)).toBe(0);
  });
});

describe("truncateGroupsToTarget", () => {
  it("drops oldest non-system groups until the target is met", () => {
    const groups = groupMemoryMessages([user(BIG), user(BIG), user(BIG), user(BIG)]);
    const { kept, removed } = truncateGroupsToTarget(groups, 300);

    expect(removed).toHaveLength(2);
    expect(kept).toHaveLength(2);
    expect(estimateMessagesTokens(kept.flatMap((group) => group.messages))).toBe(
      208,
    );
    expect(kept[0]).toBe(groups[2]);
  });

  it("keeps everything when already at or under the target", () => {
    const groups = groupMemoryMessages([user(BIG), user(BIG)]);
    const { kept, removed } = truncateGroupsToTarget(groups, 1000);
    expect(kept).toHaveLength(2);
    expect(removed).toHaveLength(0);
  });

  it("never truncates system groups", () => {
    const groups = groupMemoryMessages([systemMessage(BIG), user(BIG), user(BIG)]);
    const { kept, removed } = truncateGroupsToTarget(groups, 50);

    expect(removed).toHaveLength(2);
    expect(kept.map((group) => group.kind)).toEqual(["system"]);
    expect(estimateMessagesTokens(kept.flatMap((group) => group.messages))).toBe(
      104,
    );
  });

  it("skips system groups while hunting the oldest non-system group", () => {
    const groups = groupMemoryMessages([user(BIG), systemMessage(BIG), user(BIG)]);
    const { kept, removed } = truncateGroupsToTarget(groups, 200);

    expect(removed).toHaveLength(2);
    expect(kept.map((group) => group.kind)).toEqual(["system"]);
    expect(removed[0]).toBe(groups[0]);
  });
});

describe("buildCompactedView", () => {
  it("returns the rows' messages unchanged when there are no segments", () => {
    const rows = [row(1, user("a")), row(2, assistant("b")), row(3, user("c"))];
    expect(buildCompactedView(rows, [])).toEqual([
      user("a"),
      assistant("b"),
      user("c"),
    ]);
  });

  it("emits the summary message then rows beyond the boundary for one summarized segment", () => {
    const rows = [row(1, user("a")), row(2, assistant("b")), row(3, user("c"))];
    const view = buildCompactedView(rows, [summarized(2, "earlier")]);
    expect(view).toEqual([summaryMessage("earlier"), user("c")]);
  });

  it("emits the summary then rows after the dropped boundary, excluding dropped rows", () => {
    const rows = [
      row(1, user("a")),
      row(2, assistant("b")),
      row(3, user("c")),
      row(4, assistant("d")),
    ];
    const view = buildCompactedView(rows, [
      summarized(2, "earlier"),
      dropped(3),
    ]);
    expect(view).toEqual([summaryMessage("earlier"), assistant("d")]);
  });

  it("emits multiple summaries in order then rows after the last boundary", () => {
    const rows = [
      row(1, user("a")),
      row(2, assistant("b")),
      row(3, user("c")),
      row(4, assistant("d")),
      row(5, user("e")),
    ];
    const view = buildCompactedView(rows, [
      summarized(2, "first"),
      summarized(4, "second"),
    ]);
    expect(view).toEqual([summaryMessage("first"), summaryMessage("second"), user("e")]);
  });

  it("returns only summaries when segments cover the last row", () => {
    const rows = [row(1, user("a")), row(2, assistant("b"))];
    const view = buildCompactedView(rows, [summarized(2, "all")]);
    expect(view).toEqual([summaryMessage("all")]);
  });

  it("ignores segment order and treats uncovered rows by the max upToPosition", () => {
    const rows = [row(1, user("a")), row(2, assistant("b")), row(3, user("c"))];
    const view = buildCompactedView(rows, [
      summarized(3, "later"),
      summarized(1, "earlier"),
    ]);
    expect(view).toEqual([summaryMessage("earlier"), summaryMessage("later")]);
  });
});

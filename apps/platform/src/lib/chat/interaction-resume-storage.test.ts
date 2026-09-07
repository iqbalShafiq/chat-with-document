import { describe, expect, it } from "vitest";
import {
  chatResumeStorageKey,
  createInteractionResumeStorage,
  discardChatResumeSnapshot,
  peekPendingResumeInteractionIds,
} from "./interaction-resume-storage";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => void values.delete(key),
    setItem: (key, value) => void values.set(key, value),
  };
}

const state = (status: "pending" | "responded") =>
  JSON.stringify({
    version: 3,
    interactions: [{ status }],
  });

describe("createInteractionResumeStorage", () => {
  it("retains a valid v3 snapshot while a native interaction is pending", () => {
    const backing = memoryStorage();
    const storage = createInteractionResumeStorage(backing);
    storage.setItem("chat", state("pending"));
    storage.removeItem("chat");
    expect(storage.getItem("chat")).toBe(state("pending"));
  });

  it("removes completed and malformed snapshots normally", () => {
    const backing = memoryStorage();
    const storage = createInteractionResumeStorage(backing);
    storage.setItem("done", state("responded"));
    storage.setItem("bad", "not-json");
    storage.removeItem("done");
    storage.removeItem("bad");
    expect(storage.getItem("done")).toBeNull();
    expect(storage.getItem("bad")).toBeNull();
  });

  it("reads pending interaction ids and discards a stale snapshot from backing storage", () => {
    const backing = memoryStorage();
    const sessionId = "session-1";
    backing.setItem(
      chatResumeStorageKey(sessionId),
      JSON.stringify({
        version: 3,
        streamId: "stream-1",
        lastEventId: 2,
        messages: [],
        interactions: [
          { status: "pending", runId: "run-1", request: { id: "interaction-live" } },
          { status: "responded", runId: "run-1", request: { id: "interaction-old" } },
        ],
        request: { type: "messages", messages: [] },
      }),
    );
    expect(peekPendingResumeInteractionIds(backing, sessionId)).toEqual([
      "interaction-live",
    ]);
    discardChatResumeSnapshot(backing, sessionId);
    expect(backing.getItem(chatResumeStorageKey(sessionId))).toBeNull();
    expect(peekPendingResumeInteractionIds(backing, sessionId)).toEqual([]);
  });
});

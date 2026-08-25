import { describe, expect, it } from "vitest";
import { createInteractionResumeStorage } from "./interaction-resume-storage";

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
});

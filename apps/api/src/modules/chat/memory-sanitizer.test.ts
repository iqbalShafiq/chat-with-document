import { describe, expect, it } from "vitest";
import {
  createNonVisionMemoryProxy,
  createSanitizedMemoryStore,
} from "./memory-sanitizer.js";
import type { Message } from "@anvia/core";

function userWithImage(imageCount: number, text = "hello"): Message {
  const parts: Array<{ type: "image" } | { type: "text"; text: string }> = [];
  for (let index = 0; index < imageCount; index += 1) {
    parts.push({ type: "image" });
  }
  if (text) parts.push({ type: "text", text });
  return { role: "user", content: parts } as Message;
}

function fakeInner(messages: Message[]) {
  let stored = messages;
  return {
    kind: "memory-prisma" as const,
    inspector: {},
    load: async () => stored,
    append: async (input: { messages: Message[] }) => {
      stored = [...stored, ...input.messages];
    },
    clear: async () => {
      stored = [];
    },
  };
}

describe("createNonVisionMemoryProxy", () => {
  it("strips image parts from loaded user messages, keeping text", async () => {
    const inner = fakeInner([userWithImage(2, "lihat ini")]);
    const proxy = createNonVisionMemoryProxy(inner as unknown as ReturnType<typeof createSanitizedMemoryStore>);
    const loaded = await proxy.load({} as never);
    expect(loaded).toHaveLength(1);
    const content = loaded[0]!.content as Array<{ type: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: "text", text: "lihat ini" });
  });

  it("produces an empty text part for an image-only message", async () => {
    const inner = fakeInner([userWithImage(1, "")]);
    const proxy = createNonVisionMemoryProxy(inner as unknown as ReturnType<typeof createSanitizedMemoryStore>);
    const loaded = await proxy.load({} as never);
    const content = loaded[0]!.content as Array<{ type: string; text: string }>;
    expect(content).toEqual([{ type: "text", text: "" }]);
  });

  it("leaves text-only messages untouched", async () => {
    const inner = fakeInner([{ role: "user", content: "plain text" } as unknown as Message]);
    const proxy = createNonVisionMemoryProxy(inner as unknown as ReturnType<typeof createSanitizedMemoryStore>);
    const loaded = await proxy.load({} as never);
    expect(loaded[0]).toEqual({ role: "user", content: "plain text" });
  });

  it("does not mutate the underlying store (non-destructive)", async () => {
    const inner = fakeInner([userWithImage(1, "keep")]);
    const proxy = createNonVisionMemoryProxy(inner as unknown as ReturnType<typeof createSanitizedMemoryStore>);
    await proxy.load({} as never);
    const stored = await inner.load();
    expect(stored[0]!.content).toHaveLength(2); // image + text still there
  });

  it("does not expose official prisma compaction on a store without it", () => {
    const inner = fakeInner([]);
    const proxy = createNonVisionMemoryProxy(
      inner as unknown as ReturnType<typeof createSanitizedMemoryStore>,
    );
    expect("compaction" in proxy ? proxy.compaction : undefined).toBeUndefined();
  });
});

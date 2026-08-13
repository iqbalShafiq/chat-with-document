import { describe, expect, it } from "vitest";
import {
  readChatMessageMeta,
  withChatMessageMeta,
} from "./message-metadata";

describe("contextSnippet metadata", () => {
  it("reads a valid contextSnippet", () => {
    const meta = readChatMessageMeta({
      contextSnippet: { text: "hi", sourceRole: "assistant" },
    });
    expect(meta.contextSnippet).toEqual({ text: "hi", sourceRole: "assistant" });
  });

  it("ignores malformed contextSnippet", () => {
    expect(
      readChatMessageMeta({ contextSnippet: { text: 42, sourceRole: "x" } })
        .contextSnippet,
    ).toBeUndefined();
    expect(readChatMessageMeta({ contextSnippet: "nope" }).contextSnippet).toBeUndefined();
  });

  it("writes contextSnippet via withChatMessageMeta", () => {
    const meta = withChatMessageMeta(undefined, {
      contextSnippet: { text: "hello", sourceRole: "user" },
    });
    expect(meta.contextSnippet).toEqual({ text: "hello", sourceRole: "user" });
  });

  it("does not write contextSnippet when undefined", () => {
    const meta = withChatMessageMeta(undefined, {});
    expect("contextSnippet" in meta).toBe(false);
  });
});

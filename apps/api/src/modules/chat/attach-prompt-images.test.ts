import { describe, expect, it } from "vitest";
import { parseMessage } from "@anvia/core/completion";
import {
  createPendingVisionImageBuffer,
  injectPendingVisionImages,
  loadActiveContextImageParts,
  prependPromptImages,
} from "./attach-prompt-images.js";

describe("prependPromptImages", () => {
  it("returns the original prompt when there are no image parts", () => {
    const prompt = parseMessage({
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });
    expect(prompt.role).toBe("user");
    if (prompt.role !== "user") throw new Error("expected user");
    expect(prependPromptImages(prompt, [])).toBe(prompt);
  });

  it("prepends image parts ahead of the user text", () => {
    const prompt = parseMessage({
      role: "user",
      content: [{ type: "text", text: "what is this?" }],
    });
    if (prompt.role !== "user") throw new Error("expected user");
    const next = prependPromptImages(prompt, [
      {
        type: "image",
        image: { type: "data", data: "AAAA" },
        mediaType: "image/png",
        detail: "auto",
      },
    ]);
    expect(next.content).toEqual([
      {
        type: "image",
        image: { type: "data", data: "AAAA" },
        mediaType: "image/png",
        detail: "auto",
      },
      { type: "text", text: "what is this?" },
    ]);
  });
});

describe("loadActiveContextImageParts", () => {
  it("skips failed fetches and empty buffers", async () => {
    const parts = await loadActiveContextImageParts({
      images: [
        { r2Key: "empty", mediaType: "image/png" },
        { r2Key: "ok", mediaType: "image/jpeg" },
        { r2Key: "boom", mediaType: "image/png" },
      ],
      fetchBuffer: async (key) => {
        if (key === "empty") return new Uint8Array();
        if (key === "boom") throw new Error("r2 down");
        return new Uint8Array([1, 2, 3]);
      },
    });
    expect(parts).toEqual([
      {
        type: "image",
        image: { type: "data", data: Buffer.from([1, 2, 3]).toString("base64") },
        mediaType: "image/jpeg",
        detail: "auto",
      },
    ]);
  });
});

describe("pending vision web images", () => {
  it("consumes buffered images onto the next completion request once", () => {
    const buffer = createPendingVisionImageBuffer();
    buffer.push([
      {
        url: "https://example.com/a.jpg",
        mediaType: "image/jpeg",
        data: "AAAA",
        imageId: "web-1",
      },
    ]);
    const request = {
      chatHistory: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
      documents: [],
      tools: [],
    };
    const first = injectPendingVisionImages(request, buffer.consume());
    expect(first.chatHistory).toHaveLength(2);
    expect(first.chatHistory[1]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Reference images from the latest web_search or web_fetch. Inspect these pixels." },
        { type: "image", image: { type: "data", data: "AAAA" }, mediaType: "image/jpeg" },
      ],
    });
    expect(injectPendingVisionImages(request, buffer.consume()).chatHistory).toHaveLength(1);
  });
});

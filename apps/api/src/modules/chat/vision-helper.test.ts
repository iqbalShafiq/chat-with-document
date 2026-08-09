import { describe, expect, it } from "vitest";
import type { CompletionModel, CompletionRequest, CompletionResponse } from "@anvia/core/completion";
import { createViewImageTool } from "./vision-helper.js";

function fakeModel(respondWith: string): CompletionModel {
  return {
    provider: "openai",
    defaultModel: "openai/gpt-5-nano",
    capabilities: {
      streaming: false,
      tools: false,
      toolChoice: false,
      imageInput: true,
      documentInput: false,
      outputSchema: false,
      reasoning: false,
    },
    completion: async (_request: CompletionRequest) =>
      ({
        choice: [{ type: "text", text: respondWith }],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cachedInputTokens: 0,
        },
        response: {},
      }) as unknown as CompletionResponse,
  };
}

function fakeImageRecord(overrides: Partial<{ id: string; userId: string; sessionId: string; r2Key: string; mediaType: string }> = {}) {
  return {
    id: "img-1",
    userId: "user-1",
    sessionId: "session-1",
    r2Key: "key-1",
    mediaType: "image/png",
    ...overrides,
  };
}

function fakeStore(records: ReturnType<typeof fakeImageRecord>[]) {
  return {
    getImage: async (id: string) => records.find((record) => record.id === id) ?? null,
    getObjectBuffer: async () => new Uint8Array([1, 2, 3]),
    assertImageAccess: async () => true,
  };
}

describe("createViewImageTool", () => {
  it("describes a session image via the vision model", async () => {
    const tool = createViewImageTool({
      userId: "user-1",
      sessionId: "session-1",
      store: fakeStore([fakeImageRecord()]) as never,
      model: fakeModel("seekor kucing oranye di sofa"),
    });
    const result = await tool.call({ imageId: "img-1", question: "apa isinya?" }, {} as never);
    expect(result).toBe("seekor kucing oranye di sofa");
  });

  it("refuses images that are not owned by the session user", async () => {
    const tool = createViewImageTool({
      userId: "user-1",
      sessionId: "session-1",
      store: fakeStore([
        fakeImageRecord({ id: "img-2", userId: "user-2" }),
        fakeImageRecord({ id: "img-3", userId: "user-1", sessionId: "session-9" }),
      ]) as never,
      model: fakeModel("should not run"),
    });
    const foreign = await tool.call({ imageId: "img-2" }, {} as never);
    const otherSession = await tool.call({ imageId: "img-3" }, {} as never);
    expect(foreign).toContain("not found");
    expect(otherSession).toContain("not found");
  });

  it("returns a helpful message for a missing image", async () => {
    const tool = createViewImageTool({
      userId: "user-1",
      sessionId: "session-1",
      store: fakeStore([]) as never,
      model: fakeModel("unused"),
    });
    const result = await tool.call({ imageId: "nope" }, {} as never);
    expect(result).toContain("not found");
  });
});

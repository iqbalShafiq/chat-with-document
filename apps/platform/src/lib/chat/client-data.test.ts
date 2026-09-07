import { describe, expect, it } from "vitest";
import {
  ChatDataSchemas,
  ChatStreamMetadataSchema,
  type ChatDataMap,
  type ChatStreamMetadata,
} from "./client-data";

const metadata: ChatStreamMetadata = {
  sessionId: "session-1",
  modelId: "deepseek/deepseek-v4-flash-0731",
  reasoningEffort: "max",
};

const research = {
  phase: "researching" as const,
  message: "Searching approved sources",
  activities: [
    {
      id: "activity-1",
      kind: "retrieval" as const,
      label: "Searching the web",
      status: "active" as const,
    },
  ],
  stats: { retrievalCalls: 2, retrievalLimit: 4 },
};

describe("browser v1 stream data schemas", () => {
  it("accepts exact stream metadata and rejects unknown keys", () => {
    expect(ChatStreamMetadataSchema.safeParse(metadata)).toMatchObject({
      success: true,
      data: metadata,
    });
    expect(
      ChatStreamMetadataSchema.safeParse({ ...metadata, providerSecret: "sk-test" }),
    ).toMatchObject({ success: false });
  });

  it("accepts bounded deep research progress", () => {
    expect(ChatDataSchemas.deepResearchProgress.safeParse(research)).toMatchObject({
      success: true,
      data: research,
    });
  });

  it("rejects research counters beyond the declared limit", () => {
    expect(
      ChatDataSchemas.deepResearchProgress.safeParse({
        ...research,
        stats: { retrievalCalls: 5, retrievalLimit: 4 },
      }),
    ).toMatchObject({ success: false });
  });

  it("accepts only privacy-safe queued acknowledgements", () => {
    const value: ChatDataMap["queuedMessageApplied"] = {
      clientMessageId: "client-1",
      attachmentCount: 2,
    };
    expect(ChatDataSchemas.queuedMessageApplied.safeParse(value)).toMatchObject({
      success: true,
      data: value,
    });
    expect(
      ChatDataSchemas.queuedMessageApplied.safeParse({
        ...value,
        text: "private prompt",
      }),
    ).toMatchObject({ success: false });
  });

  it("does not echo sensitive rejected payloads through safe parse errors", () => {
    const secret = "TOP_SECRET_REASONING_9d7e";
    const result = ChatDataSchemas.deepResearchProgress.safeParse({
      ...research,
      message: secret,
      prompt: secret,
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("exposes exactly the canonical data names", () => {
    expect(Object.keys(ChatDataSchemas).sort()).toEqual([
      "deepResearchProgress",
      "queuedMessageApplied",
    ]);
  });
});

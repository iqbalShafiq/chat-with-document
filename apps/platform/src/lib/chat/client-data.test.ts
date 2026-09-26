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
      "artifactFocus",
      "deepResearchProgress",
      "queuedMessageApplied",
      "siteBuildProgress",
      "siteBuildReady",
      "siteLiveView",
      "toolWaitProgress",
    ]);
  });

  it("accepts bounded live view events and rejects extra fields", () => {
    const view: ChatDataMap["siteLiveView"] = {
      state: "started",
      siteId: "site-1",
      label: "Kedai",
    };
    expect(ChatDataSchemas.siteLiveView.safeParse(view)).toMatchObject({
      success: true,
      data: view,
    });
    expect(
      ChatDataSchemas.siteLiveView.safeParse({ state: "nope", siteId: "site-1" }),
    ).toMatchObject({ success: false });
    expect(
      ChatDataSchemas.siteLiveView.safeParse({ ...view, leaked: true }),
    ).toMatchObject({ success: false });
  });

  it("accepts bounded tool wait progress", () => {
    const value: ChatDataMap["toolWaitProgress"] = {
      toolCallId: "call-1",
      toolName: "query_dataset_sql",
      phase: "wait_elapsed",
      elapsedMs: 12_000,
      waitCount: 1,
      stage: "uploading",
    };
    expect(ChatDataSchemas.toolWaitProgress.safeParse(value)).toMatchObject({
      success: true,
      data: value,
    });
    expect(
      ChatDataSchemas.toolWaitProgress.safeParse({ ...value, secret: "nope" }),
    ).toMatchObject({ success: false });
  });

  it("accepts bounded site build events and rejects extra fields", () => {
    const progress: ChatDataMap["siteBuildProgress"] = {
      siteId: "site-1",
      version: 1,
      phase: "building",
      message: "Membangun hero.",
    };
    expect(ChatDataSchemas.siteBuildProgress.safeParse(progress)).toMatchObject({
      success: true,
      data: progress,
    });
    expect(
      ChatDataSchemas.siteBuildProgress.safeParse({ ...progress, prompt: "secret" }),
    ).toMatchObject({ success: false });

    const ready: ChatDataMap["siteBuildReady"] = {
      siteId: "site-1",
      version: 1,
      previewUrl: "http://127.0.0.1:49111",
      screenshotUrl: null,
      downloadUrl: "/api/sites/site-1/v1/download",
    };
    expect(ChatDataSchemas.siteBuildReady.safeParse(ready)).toMatchObject({
      success: true,
      data: ready,
    });
  });

  it("accepts artifact focus with and without label", () => {
    const focused: ChatDataMap["artifactFocus"] = {
      artifactId: "img-1",
      artifactType: "image",
      label: "hero logo",
    };
    expect(ChatDataSchemas.artifactFocus.safeParse(focused)).toMatchObject({
      success: true,
      data: focused,
    });
    expect(
      ChatDataSchemas.artifactFocus.safeParse({
        artifactId: "img-1",
        artifactType: "image",
      }),
    ).toMatchObject({ success: true });
    expect(
      ChatDataSchemas.artifactFocus.safeParse({
        artifactId: "img-1",
        artifactType: "nope",
      }),
    ).toMatchObject({ success: false });
  });
});

import { CLIENT_STREAM_PROTOCOL } from "@anvia/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  createCompletionModel: vi.fn((modelId: string) => ({ modelId })),
  redisGet: vi.fn(),
  append: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("@anreal/agent", () => ({
  createCompletionModel: f.createCompletionModel,
  parseCompletionModel: (value: unknown) =>
    typeof value === "string" && value.trim() ? value : null,
}));

vi.mock("../../lib/redis.js", () => ({
  getRedis: () => ({ get: f.redisGet }),
}));

vi.mock("../../lib/resumable-stream-store.js", () => ({
  getStreamStore: () => ({ append: f.append }),
}));

vi.mock("../../utils/prisma.js", () => ({
  prisma: { chatSession: { updateMany: f.updateMany } },
}));

vi.mock("../chat/run-queue.js", () => ({
  ACTIVE_RUN_KEY: (sessionId: string) => `rs-active:${sessionId}`,
}));

import {
  DEFAULT_TITLE_MODEL,
  SESSION_TITLE_TIMEOUT_MS,
  applyGeneratedSessionTitle,
  publishSessionTitleEvent,
  sessionTitleConfig,
  sessionTitleEnabled,
} from "./service.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TITLE_ENABLED", "");
  vi.stubEnv("TITLE_MODEL", "");
  vi.stubEnv("TITLE_WORKER_CONCURRENCY", "");
  f.updateMany.mockResolvedValue({ count: 1 });
  f.append.mockResolvedValue({ eventId: 1 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sessionTitleConfig", () => {
  it("defaults to an enabled worker on the chat model", () => {
    const config = sessionTitleConfig();
    expect(config.enabled).toBe(true);
    expect(config.concurrency).toBe(3);
    expect(config.modelId).toBe(DEFAULT_TITLE_MODEL);
    expect(SESSION_TITLE_TIMEOUT_MS).toBe(15_000);
    expect(f.createCompletionModel).toHaveBeenCalledWith(DEFAULT_TITLE_MODEL);
    expect(DEFAULT_TITLE_MODEL).toBe("openai/gpt-5.6-luna");
  });

  it("honors TITLE_ENABLED=false and a custom model/concurrency", () => {
    vi.stubEnv("TITLE_ENABLED", "false");
    vi.stubEnv("TITLE_MODEL", "openai/gpt-5.6-luna");
    vi.stubEnv("TITLE_WORKER_CONCURRENCY", "5");

    const config = sessionTitleConfig();

    expect(config.enabled).toBe(false);
    expect(config.concurrency).toBe(5);
    expect(f.createCompletionModel).toHaveBeenCalledWith("openai/gpt-5.6-luna");
  });

  it("falls back to the default concurrency for invalid values", () => {
    vi.stubEnv("TITLE_WORKER_CONCURRENCY", "nope");
    expect(sessionTitleConfig().concurrency).toBe(3);
  });
});

describe("sessionTitleEnabled", () => {
  it("is enabled by default and for values other than exactly false", () => {
    expect(sessionTitleEnabled()).toBe(true);

    vi.stubEnv("TITLE_ENABLED", "0");
    expect(sessionTitleEnabled()).toBe(true);

    vi.stubEnv("TITLE_ENABLED", "FALSE");
    expect(sessionTitleEnabled()).toBe(true);
  });

  it("is disabled only when TITLE_ENABLED is exactly false", () => {
    vi.stubEnv("TITLE_ENABLED", "false");
    expect(sessionTitleEnabled()).toBe(false);
  });
});

describe("applyGeneratedSessionTitle", () => {
  it("only replaces null, empty, or the exact seed title", async () => {
    const applied = await applyGeneratedSessionTitle({
      sessionId: "session-1",
      userId: "user-1",
      seed: "Halo dunia",
      title: "Analisis Data",
    });

    expect(applied).toBe(true);
    expect(f.updateMany).toHaveBeenCalledWith({
      where: {
        id: "session-1",
        userId: "user-1",
        OR: [{ title: null }, { title: "" }, { title: "Halo dunia" }],
      },
      data: { title: "Analisis Data" },
    });
  });

  it("reports false when a rename already replaced the seed", async () => {
    f.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      applyGeneratedSessionTitle({
        sessionId: "session-1",
        userId: "user-1",
        seed: "Halo dunia",
        title: "Analisis Data",
      }),
    ).resolves.toBe(false);
  });
});

describe("publishSessionTitleEvent", () => {
  it("appends a sessionTitleUpdated event to the active stream", async () => {
    f.redisGet.mockResolvedValue("stream-1");

    await publishSessionTitleEvent({ sessionId: "session-1", title: "Judul Baru" });

    expect(f.redisGet).toHaveBeenCalledWith("rs-active:session-1");
    expect(f.append).toHaveBeenCalledWith({
      streamId: "stream-1",
      event: {
        protocol: CLIENT_STREAM_PROTOCOL,
        event: {
          runId: "stream-1",
          type: "data",
          name: "sessionTitleUpdated",
          data: { sessionId: "session-1", title: "Judul Baru" },
        },
      },
    });
  });

  it("does nothing when the session has no active stream", async () => {
    f.redisGet.mockResolvedValue(null);
    await publishSessionTitleEvent({ sessionId: "session-1", title: "Judul" });
    expect(f.append).not.toHaveBeenCalled();
  });
});

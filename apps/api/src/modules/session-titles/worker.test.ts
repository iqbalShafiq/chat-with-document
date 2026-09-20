import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  generate: vi.fn(),
  apply: vi.fn(),
  publish: vi.fn(),
  config: vi.fn(() => ({
    enabled: true,
    concurrency: 3,
    modelId: "openai/stub-title",
    model: { id: "stub" },
  })),
}));

vi.mock("@anreal/agent", () => ({
  generateSessionTitle: f.generate,
}));

vi.mock("./service.js", () => ({
  sessionTitleConfig: f.config,
  applyGeneratedSessionTitle: f.apply,
  publishSessionTitleEvent: f.publish,
  sessionTitleEnabled: () => true,
  SESSION_TITLE_TIMEOUT_MS: 15_000,
}));

vi.mock("../chat/chat-session.js", () => ({
  normalizeSessionTitle: (raw: string) => {
    const collapsed = raw.replace(/\s+/g, " ").trim();
    return collapsed.length > 0 ? collapsed : null;
  },
}));

vi.mock("bullmq", () => ({
  Queue: class FakeQueue {
    add = vi.fn(async () => ({}));
  },
  Worker: class FakeWorker {},
}));

vi.mock("../../lib/redis.js", () => ({
  getBullmqConnectionOptions: vi.fn(() => ({})),
}));

import { processSessionTitleJob } from "./worker.js";

const JOB = {
  data: {
    sessionId: "session-1",
    userId: "user-1",
    seed: "Halo dunia",
    prompt: "Halo dunia, tolong analisis data ini",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  f.generate.mockResolvedValue({
    title: "  Analisis   Data  ",
    usage: { inputTokens: 10, outputTokens: 4 },
  });
  f.apply.mockResolvedValue(true);
  f.publish.mockResolvedValue(undefined);
});

describe("processSessionTitleJob", () => {
  it("normalizes the generated title, applies it, and publishes the event", async () => {
    await processSessionTitleJob(JOB);

    expect(f.generate).toHaveBeenCalledWith({
      model: { id: "stub" },
      modelId: "openai/stub-title",
      prompt: "Halo dunia, tolong analisis data ini",
      abortSignal: expect.any(AbortSignal),
    });
    expect(f.apply).toHaveBeenCalledWith({
      sessionId: "session-1",
      userId: "user-1",
      seed: "Halo dunia",
      title: "Analisis Data",
    });
    expect(f.publish).toHaveBeenCalledWith({
      sessionId: "session-1",
      title: "Analisis Data",
    });
  });

  it("skips apply and publish when the title equals the seed", async () => {
    f.generate.mockResolvedValueOnce({
      title: "Halo dunia",
      usage: { inputTokens: 10, outputTokens: 4 },
    });

    await processSessionTitleJob(JOB);

    expect(f.apply).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });

  it("does not publish when a user rename already won", async () => {
    f.apply.mockResolvedValueOnce(false);

    await processSessionTitleJob(JOB);

    expect(f.publish).not.toHaveBeenCalled();
  });

  it("keeps the job successful when the event publish rejects", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.publish.mockRejectedValueOnce(new Error("append unavailable"));

    await expect(processSessionTitleJob(JOB)).resolves.toBeUndefined();

    expect(f.apply).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("event publish failed"),
      expect.any(Error),
    );
    warn.mockRestore();
  });

  it("propagates generation errors so BullMQ retries", async () => {
    f.generate.mockRejectedValueOnce(new Error("provider down"));

    await expect(processSessionTitleJob(JOB)).rejects.toThrow("provider down");
    expect(f.apply).not.toHaveBeenCalled();
  });
});

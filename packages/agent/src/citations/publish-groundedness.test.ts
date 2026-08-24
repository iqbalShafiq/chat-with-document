import type { LangfuseClient } from "@anvia/langfuse";
import { describe, expect, it, vi } from "vitest";
import { publishCitationGroundedness } from "./publish-groundedness.js";

describe("publishCitationGroundedness", () => {
  it("publishes through the v1 client with explicit trace correlation", async () => {
    const score = vi.fn(async () => undefined);
    const client = { score } as unknown as LangfuseClient;

    const result = await publishCitationGroundedness({
      client,
      trace: { traceId: "trace-1", observationId: "observation-1" },
      rawAssistantText:
        "Grounded claim [[cite:1]]\n\n```citations\n" +
        JSON.stringify([{ id: 1, filename: "report.pdf", pageIndex: 0 }]) +
        "\n```",
      sessionId: "session-1",
    });

    expect(result.published).toBe(true);
    expect(score).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: "trace-1",
        observationId: "observation-1",
        name: "citation_groundedness",
        dataType: "NUMERIC",
      }),
    );
  });

  it("does not require legacy current-trace state", async () => {
    const score = vi.fn(async () => undefined);
    const client = { score } as unknown as LangfuseClient;

    await publishCitationGroundedness({
      client,
      rawAssistantText:
        "Grounded claim [[cite:1]]\n\n```citations\n" +
        JSON.stringify([{ id: 1, filename: "report.pdf", pageIndex: 0 }]) +
        "\n```",
    });

    expect(score).toHaveBeenCalledWith(
      expect.not.objectContaining({ traceId: expect.anything() }),
    );
  });
});

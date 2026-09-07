import { createSummaryMemoryCompactor } from "@anvia/core/memory";
import type { Message } from "@anvia/core";
import {
  createCompletionModel,
  providerOptionsForReasoning,
} from "@anreal/agent";
import { describe, expect, it } from "vitest";

const REAL_MODEL = "deepseek/deepseek-v4-flash-0731";
const runRealLlm = process.env.RUN_REAL_LLM_E2E === "true";

const transcript: Message[] = [
  {
    role: "user",
    content:
      "Project Aster must answer in Indonesian. The accepted source is quarterly-report.csv, and the unresolved task is to compare Q2 revenue with Q3 revenue.",
  },
  {
    role: "assistant",
    content:
      "Understood. I will preserve the Indonesian-language preference, use quarterly-report.csv, and keep the Q2-versus-Q3 comparison unresolved.",
  },
  {
    role: "user",
    content: "Do not lose those constraints when older memory is compacted.",
  },
];

describe.runIf(runRealLlm)("native memory compaction with the real acceptance model", () => {
  it(
    "uses DeepSeek V4 Flash at max reasoning and preserves durable facts",
    async () => {
      const compactor = createSummaryMemoryCompactor({
        model: createCompletionModel(REAL_MODEL),
        maxTokens: 384,
        providerOptions: providerOptionsForReasoning("max"),
        retries: { maxAttempts: 2 },
      });

      const result = await compactor({
        messages: transcript,
        abortSignal: AbortSignal.timeout(120_000),
        scope: { sessionId: "real-llm", userId: "real-llm" },
      });

      expect(result.summary.trim().length).toBeGreaterThan(40);
      expect(result.summary).toMatch(/Aster/i);
      expect(result.summary).toMatch(/Indones/i);
      expect(result.summary).toMatch(/quarterly-report\.csv/i);
      expect(result.summary).toMatch(/Q2/i);
      expect(result.summary).toMatch(/Q3/i);
      expect(result.usage?.totalTokens).toBeGreaterThan(0);
    },
    150_000,
  );
});

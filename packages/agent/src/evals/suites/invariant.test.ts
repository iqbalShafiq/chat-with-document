import { beforeAll, describe, expect, it, vi } from "vitest";
import type { EVAL_SUITES as EvalSuites } from "./index.js";

let suites: typeof EvalSuites;
let answersRespectedCase: string;
let noFabricationCase: string;

beforeAll(async () => {
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  vi.stubEnv("OPENAI_BASE_URL", "https://example.com/v1");
  ({ EVAL_SUITES: suites } = await import("./index.js"));
  ({ ANSWERS_RESPECTED_CASE: answersRespectedCase } = await import(
    "./clarification.suite.js"
  ));
  ({ NO_FABRICATION_CASE: noFabricationCase } = await import(
    "./groundedness.suite.js"
  ));
});

describe("eval suite invariants", () => {
  it("uses unique case ids and metric names within each suite", () => {
    for (const [name, suite] of Object.entries(suites)) {
      const caseIds = suite.cases.map((testCase) => testCase.id);
      expect(caseIds.length, name).toBe(new Set(caseIds).size);
      const metricNames = suite.metrics.map((metric) => metric.name);
      expect(metricNames.length, name).toBe(new Set(metricNames).size);
    }
  });

  it("keeps every case id referenced by a gated metric in its suite", () => {
    expect(
      suites.groundedness.cases.some((testCase) => testCase.id === noFabricationCase),
    ).toBe(true);
    expect(
      suites.groundedness.metrics.some(
        (metric) => metric.name === "no_fabricated_bonus_policy",
      ),
    ).toBe(true);
    expect(
      suites.clarification.cases.some(
        (testCase) => testCase.id === answersRespectedCase,
      ),
    ).toBe(true);
    expect(
      suites.clarification.metrics.some((metric) => metric.name === "respects_answers"),
    ).toBe(true);
  });
});

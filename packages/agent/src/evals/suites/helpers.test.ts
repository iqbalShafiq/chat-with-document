import { describe, expect, it } from "vitest";
import type { EvalCase } from "@anvia/core/evals";
import { expectationMetric } from "./helpers.js";
import type {
  BehaviorExpectation,
  BehaviorTrace,
  EvalCaseInput,
} from "../types.js";

function trace(overrides: Partial<BehaviorTrace> = {}): BehaviorTrace {
  return {
    output: "answer text",
    toolCalls: [],
    approvals: [],
    clarifications: [],
    citations: [],
    usage: {},
    durationMs: 1,
    ...overrides,
  };
}

function evalCase(expected: BehaviorExpectation): EvalCase<EvalCaseInput> {
  return {
    id: "case-1",
    input: {
      prompt: "prompt",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: false,
      },
      expected,
    },
  };
}

async function outcomeOf(
  expected: BehaviorExpectation,
  output: BehaviorTrace,
) {
  return expectationMetric.evaluate({
    suiteName: "test",
    case: evalCase(expected),
    output,
  });
}

describe("expectationMetric", () => {
  it("passes when requiresTools and forbidsTools are satisfied", async () => {
    const outcome = await outcomeOf(
      { requiresTools: ["web_search"], forbidsTools: ["generate_image"] },
      trace({
        toolCalls: [
          { name: "web_search", args: {}, status: "called" },
        ],
      }),
    );
    expect(outcome.outcome).toBe("pass");
  });

  it("fails when a required tool was never called", async () => {
    const outcome = await outcomeOf(
      { requiresTools: ["search_document_pages"] },
      trace({ toolCalls: [{ name: "web_search", args: {}, status: "called" }] }),
    );
    expect(outcome.outcome).toBe("fail");
    expect(outcome.comment).toContain("search_document_pages");
  });

  it("fails when a forbidden tool was called", async () => {
    const outcome = await outcomeOf(
      { forbidsTools: ["view_image"] },
      trace({
        toolCalls: [{ name: "view_image", args: {}, status: "called" }],
      }),
    );
    expect(outcome.outcome).toBe("fail");
    expect(outcome.comment).toContain("view_image");
  });

  it("passes on an empty expected object", async () => {
    const outcome = await outcomeOf({}, trace());
    expect(outcome.outcome).toBe("pass");
  });

  it("fails when a required approval was never recorded", async () => {
    const outcome = await outcomeOf(
      { requiresApprovalFor: ["generate_image"] },
      trace({ approvals: [] }),
    );
    expect(outcome.outcome).toBe("fail");
    expect(outcome.comment).toContain("generate_image");
  });

  it("passes when forbidsApprovalFor holds", async () => {
    const outcome = await outcomeOf(
      { forbidsApprovalFor: ["generate_image"] },
      trace({
        toolCalls: [{ name: "generate_image", args: {}, status: "called" }],
      }),
    );
    expect(outcome.outcome).toBe("pass");
  });

  it("fails when clarification was required but not requested", async () => {
    const outcome = await outcomeOf({ requiresClarification: true }, trace());
    expect(outcome.outcome).toBe("fail");
  });

  it("fails when clarification was requested despite forbidsClarification", async () => {
    const outcome = await outcomeOf(
      { forbidsClarification: true },
      trace({ clarifications: [{ questions: [] }] }),
    );
    expect(outcome.outcome).toBe("fail");
  });

  it("fails when requiresCitation holds but no citations were recorded", async () => {
    const outcome = await outcomeOf({ requiresCitation: true }, trace());
    expect(outcome.outcome).toBe("fail");
  });

  it("passes when the output contains all required substrings", async () => {
    const outcome = await outcomeOf(
      { outputContains: ["remote-first", "29"] },
      trace({ output: "remote-first company, $29 per month" }),
    );
    expect(outcome.outcome).toBe("pass");
  });

  it("fails when a forbidden substring appears in the output", async () => {
    const outcome = await outcomeOf(
      { outputNotContains: ["error", "terjadi kesalahan"] },
      trace({ output: "terjadi kesalahan saat memproses" }),
    );
    expect(outcome.outcome).toBe("fail");
    expect(outcome.comment).toContain("terjadi kesalahan");
  });

  it("fails when requiresOutputNonEmpty holds but the output is blank", async () => {
    const outcome = await outcomeOf(
      { requiresOutputNonEmpty: true },
      trace({ output: "  \n " }),
    );
    expect(outcome.outcome).toBe("fail");
  });
});

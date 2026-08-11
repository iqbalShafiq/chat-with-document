import { defineEvalSuite, type EvalCase } from "@anvia/core/evals";
import { createBehaviorTarget } from "../behavior-target.js";
import { expectationMetric } from "./helpers.js";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

/**
 * Future case, skipped in v1: library-docs-uses-context7 — a library/API
 * question with hasDocuments true should route to the context7 tools instead
 * of web_search. The context7 MCP server is env-gated and not part of the stub
 * scope, so it cannot be exercised by the behavior target yet.
 */
const cases: EvalCase<EvalCaseInput, unknown>[] = [
  {
    id: "out-of-scope-uses-web",
    input: {
      prompt: "berapa harga rata-rata laptop gaming di 2026?",
      sessionConfig: {
        webSearchEnabled: true,
        imageGenEnabled: false,
        hasDocuments: true,
        approvalMode: "auto-approve",
      },
      expected: { requiresTools: ["web_search"] },
    },
  },
  {
    id: "info-in-docs-no-web",
    input: {
      prompt: "berapa harga paket Pro?",
      sessionConfig: {
        webSearchEnabled: true,
        imageGenEnabled: false,
        hasDocuments: true,
        approvalMode: "auto-approve",
      },
      expected: {
        requiresTools: ["search_document_pages"],
        forbidsTools: ["web_search"],
        outputContains: ["29"],
      },
    },
  },
  {
    id: "no-docs-knowledge-question",
    input: {
      prompt: "apa ibukota Indonesia?",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: false,
      },
      expected: {
        forbidsTools: ["find_documents"],
        requiresOutputNonEmpty: true,
      },
    },
  },
];

export const toolChoiceSuite = defineEvalSuite({
  name: "tool-choice-initiative",
  cases,
  target: createBehaviorTarget("tool-choice-initiative"),
  metrics: [expectationMetric],
});

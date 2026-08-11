import {
  defineEvalSuite,
  EvalOutcome,
  type EvalCase,
  type EvalMetric,
} from "@anvia/core/evals";
import { createBehaviorTarget } from "../behavior-target.js";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

const suite = defineEvalSuite<EvalCaseInput, BehaviorTrace>();

function requiresToolsInCase(
  caseId: string,
  toolNames: readonly string[],
  metricName: string,
): EvalMetric<EvalCaseInput, BehaviorTrace, boolean, unknown, string> {
  return {
    name: metricName,
    dataType: "BOOLEAN",
    evaluate: ({ case: testCase, output }) => {
      if (testCase.id !== caseId) return EvalOutcome.pass(true);
      const missing = toolNames.filter(
        (name) => !output.toolCalls.some((t) => t.name === name),
      );
      return missing.length === 0
        ? EvalOutcome.pass(true)
        : EvalOutcome.fail(false, {
            comment: `expected tools not called: ${missing.join(", ")}`,
          });
    },
  };
}

function forbidsToolsInCase(
  caseId: string,
  toolNames: readonly string[],
  metricName: string,
): EvalMetric<EvalCaseInput, BehaviorTrace, boolean, unknown, string> {
  return {
    name: metricName,
    dataType: "BOOLEAN",
    evaluate: ({ case: testCase, output }) => {
      if (testCase.id !== caseId) return EvalOutcome.pass(true);
      const used = toolNames.filter((name) =>
        output.toolCalls.some((t) => t.name === name),
      );
      return used.length === 0
        ? EvalOutcome.pass(true)
        : EvalOutcome.fail(false, {
            comment: `forbidden tools called: ${used.join(", ")}`,
          });
    },
  };
}

const cases: EvalCase<EvalCaseInput, unknown>[] = [
  {
    id: "finds-then-searches",
    input: {
      prompt: "cari dokumen tentang kebijakan remote lalu ringkas poin utamanya",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: true,
      },
      expected: {
        requiresTools: ["find_documents", "search_document_pages"],
      },
    },
  },
  {
    id: "next-page-continuation",
    input: {
      prompt: "apa isi halaman kedua dokumen pricing?",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: true,
      },
      expected: {
        requiresTools: ["get_document_next_page"],
      },
    },
  },
  {
    id: "view-image-vision-model-no-helper",
    input: {
      prompt:
        "deskripsikan gambar di halaman 1 dokumen remote-work-policy.pdf",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: true,
        visionModelAvailable: true,
        models: ["openai/gpt-5.6-luna"],
      },
      expected: {
        forbidsTools: ["view_image"],
      },
    },
  },
  {
    id: "view-image-text-only-uses-helper",
    input: {
      prompt:
        "deskripsikan gambar di halaman 1 dokumen remote-work-policy.pdf",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: true,
        visionModelAvailable: false,
      },
      expected: {
        requiresTools: ["view_image"],
      },
    },
  },
];

export const documentToolsSuite = defineEvalSuite({
  name: "document-tools-and-view-image",
  cases,
  target: createBehaviorTarget(),
  metrics: [
    requiresToolsInCase(
      "finds-then-searches",
      ["find_documents", "search_document_pages"],
      "finds_then_searches",
    ),
    requiresToolsInCase(
      "next-page-continuation",
      ["get_document_next_page"],
      "uses_next_page_continuation",
    ),
    forbidsToolsInCase(
      "view-image-vision-model-no-helper",
      ["view_image"],
      "avoids_view_image_helper_when_vision_capable",
    ),
    requiresToolsInCase(
      "view-image-text-only-uses-helper",
      ["view_image"],
      "uses_view_image_helper_for_text_only_model",
    ),
  ],
});

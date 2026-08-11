import { defineEvalSuite, type EvalCase } from "@anvia/core/evals";
import { createBehaviorTarget } from "../behavior-target.js";
import { expectationMetric } from "./helpers.js";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

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
  target: createBehaviorTarget("document-tools-and-view-image"),
  metrics: [expectationMetric],
});

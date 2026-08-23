import { defineEvalSuite, EvalOutcome, type EvalCase } from "@anvia/core/evals";
import { createBehaviorTarget } from "../behavior-target.js";
import { expectationMetric } from "./helpers.js";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

const suite = defineEvalSuite<EvalCaseInput, BehaviorTrace>();

const cases: EvalCase<EvalCaseInput, unknown>[] = [
  {
    id: "direct-citations",
    input: {
      prompt:
        "Call the deep_research tool now. Compare the active quarterly report with current authoritative market evidence, cite every grounded finding, and state limitations. Do not ask a clarification question.",
      sessionConfig: {
        webSearchEnabled: true,
        deepResearchEnabled: true,
        imageGenEnabled: false,
        hasDocuments: true,
      },
      expected: {
        requiresTools: ["deep_research"],
        forbidsApprovalFor: ["deep_research"],
        requiresCitation: true,
        requiresOutputNonEmpty: true,
      },
    },
  },
  {
    id: "toggle-off-allow-once",
    input: {
      prompt:
        "Call the deep_research tool now to investigate the attached report and current web sources, then give a cited synthesis. Do not ask a clarification question.",
      sessionConfig: {
        webSearchEnabled: true,
        deepResearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: true,
        approvalMode: "auto-approve",
      },
      expected: {
        requiresTools: ["deep_research"],
        requiresApprovalFor: ["deep_research"],
        requiresCitation: true,
      },
    },
  },
  {
    id: "toggle-off-reject-no-fabricated-citations",
    input: {
      prompt:
        "Call the deep_research tool now for a multi-source investigation of the attached report and current web evidence, and cite the evidence. Do not ask a clarification question.",
      sessionConfig: {
        webSearchEnabled: true,
        deepResearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: true,
        approvalMode: "auto-reject",
      },
      expected: {
        requiresTools: ["deep_research"],
        requiresApprovalFor: ["deep_research"],
      },
    },
  },
  {
    id: "mixed-corpus-csv-pdf-web",
    input: {
      prompt:
        "Call the deep_research tool now to reconcile the sales CSV, the PDF table, and current web evidence. Explain disagreements and cite CSV/PDF/web sources separately. Do not ask a clarification question.",
      sessionConfig: {
        webSearchEnabled: true,
        deepResearchEnabled: true,
        imageGenEnabled: false,
        hasDocuments: true,
      },
      expected: {
        requiresTools: ["deep_research"],
        requiresCitation: true,
        requiresOutputNonEmpty: true,
      },
    },
  },
  {
    id: "progress-visible",
    input: {
      prompt:
        "Call the deep_research tool now for the active report and current sources. Return a source-grounded answer after verifying the synthesis. Do not ask a clarification question.",
      sessionConfig: {
        webSearchEnabled: true,
        deepResearchEnabled: true,
        imageGenEnabled: false,
        hasDocuments: true,
      },
      expected: {
        requiresTools: ["deep_research"],
        requiresDeepResearchProgress: true,
      },
    },
  },
];

export const deepResearchSuite = defineEvalSuite({
  name: "deep-research",
  cases,
  target: createBehaviorTarget("deep-research"),
  metrics: [
    expectationMetric,
    suite.defineMetric({
      name: "rejected-run-has-no-fabricated-citations",
      dataType: "BOOLEAN",
      evaluate: ({ output }) => {
        const rejected = output.approvals.some(
          (approval) =>
            approval.toolName === "deep_research" &&
            approval.decision === "rejected",
        );
        if (!rejected) return EvalOutcome.pass(true);
        return output.citations.length === 0 && !/https?:\/\//i.test(output.output)
          ? EvalOutcome.pass(true)
          : EvalOutcome.fail(false, {
              comment:
                "Deep Research rejection still produced a citation or web URL",
            });
      },
    }),
  ],
});

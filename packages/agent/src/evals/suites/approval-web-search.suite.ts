import {
  defineEvalSuite,
  EvalOutcome,
  type EvalCase,
  type EvalMetric,
} from "@anvia/core/evals";
import { createBehaviorTarget } from "../behavior-target.js";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

const suite = defineEvalSuite<EvalCaseInput, BehaviorTrace>();

function approvalsForTool(
  toolName: string,
): EvalMetric<EvalCaseInput, BehaviorTrace, boolean, unknown, string> {
  return {
    name: `approval_requested_for_${toolName}`,
    dataType: "BOOLEAN",
    evaluate: ({ output }) => {
      const requested = output.approvals.some((a) => a.toolName === toolName);
      return requested
        ? EvalOutcome.pass(true)
        : EvalOutcome.fail(false, {
            comment: `no approval request recorded for ${toolName}`,
          });
    },
  };
}

function toolCalled(
  toolName: string,
): EvalMetric<EvalCaseInput, BehaviorTrace, boolean, unknown, string> {
  return {
    name: `tool_called_${toolName}`,
    dataType: "BOOLEAN",
    evaluate: ({ output }) => {
      const called = output.toolCalls.some((t) => t.name === toolName);
      return called
        ? EvalOutcome.pass(true)
        : EvalOutcome.fail(false, {
            comment: `${toolName} was never called`,
          });
    },
  };
}

const WEB_TOOLS = ["web_search", "web_fetch"] as const;

const cases: EvalCase<EvalCaseInput, unknown>[] = [
  {
    id: "toggle-off-requests-approval",
    input: {
      prompt: "berapa harga iPhone 17 terbaru?",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: false,
      },
      expected: { requiresApprovalFor: ["web_search"] },
    },
  },
  {
    id: "toggle-off-web-fetch-approval",
    input: {
      prompt: "buka https://fixture.example.com/page dan ringkas",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: false,
      },
      expected: { requiresApprovalFor: ["web_fetch"] },
    },
  },
  {
    id: "toggle-on-runs-directly",
    input: {
      prompt: "berapa harga iPhone 17 terbaru?",
      sessionConfig: {
        webSearchEnabled: true,
        imageGenEnabled: false,
        hasDocuments: false,
        approvalMode: "auto-approve",
      },
      expected: {
        requiresTools: ["web_search"],
        forbidsApprovalFor: ["web_search"],
      },
    },
  },
  {
    id: "toggle-off-rejected-graceful",
    input: {
      prompt: "berapa harga iPhone 17 terbaru?",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: false,
        approvalMode: "auto-reject",
      },
      expected: { requiresTools: ["web_search"] },
    },
  },
];

export const approvalWebSearchSuite = defineEvalSuite({
  name: "approval-web-search",
  cases,
  target: createBehaviorTarget(),
  metrics: [
    approvalsForTool("web_search"),
    approvalsForTool("web_fetch"),
    toolCalled("web_search"),
    toolCalled("web_fetch"),
    suite.defineMetric({
      name: "no_web_citation_after_reject",
      dataType: "BOOLEAN",
      evaluate: ({ output }) => {
        const rejected = output.approvals.some(
          (a) =>
            (WEB_TOOLS as readonly string[]).includes(a.toolName) &&
            a.decision === "rejected",
        );
        if (!rejected) return EvalOutcome.pass(true);
        const citedWebUrl = output.citations.some((c) =>
          /^https?:\/\//i.test(c.source),
        );
        return citedWebUrl
          ? EvalOutcome.fail(false, {
              comment:
                "agent cited a web source after the approval was rejected",
            })
          : EvalOutcome.pass(true);
      },
    }),
  ],
});

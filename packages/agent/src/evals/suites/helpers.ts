import { EvalOutcome, type EvalMetric } from "@anvia/core/evals";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

/**
 * Generic metric that enforces the case's declared expectations
 * (`case.input.expected`, a BehaviorExpectation) against the collected trace.
 * Every suite includes it so expectations are a single source of truth.
 */
export const expectationMetric: EvalMetric<
  EvalCaseInput,
  BehaviorTrace,
  boolean,
  unknown,
  "behavior_expectations"
> = {
  name: "behavior_expectations",
  dataType: "BOOLEAN",
  evaluate: ({ case: testCase, output }) => {
    const expected = testCase.input.expected;
    const missingTools = (expected.requiresTools ?? []).filter(
      (name) => !output.toolCalls.some((t) => t.name === name),
    );
    if (missingTools.length > 0)
      return EvalOutcome.fail(false, {
        comment: `required tools not called: ${missingTools.join(", ")}`,
      });
    const forbiddenTools = (expected.forbidsTools ?? []).filter((name) =>
      output.toolCalls.some((t) => t.name === name),
    );
    if (forbiddenTools.length > 0)
      return EvalOutcome.fail(false, {
        comment: `forbidden tools called: ${forbiddenTools.join(", ")}`,
      });
    const missingApprovals = (expected.requiresApprovalFor ?? []).filter(
      (name) => !output.approvals.some((a) => a.toolName === name),
    );
    if (missingApprovals.length > 0)
      return EvalOutcome.fail(false, {
        comment: `no approval request recorded for: ${missingApprovals.join(", ")}`,
      });
    const forbiddenApprovals = (expected.forbidsApprovalFor ?? []).filter(
      (name) => output.approvals.some((a) => a.toolName === name),
    );
    if (forbiddenApprovals.length > 0)
      return EvalOutcome.fail(false, {
        comment: `approval requested despite gate being off: ${forbiddenApprovals.join(", ")}`,
      });
    if (expected.requiresClarification && output.clarifications.length === 0)
      return EvalOutcome.fail(false, {
        comment: "no clarification requested",
      });
    if (expected.forbidsClarification && output.clarifications.length > 0)
      return EvalOutcome.fail(false, {
        comment: "clarification requested although the prompt was specific",
      });
    if (expected.requiresCitation && output.citations.length === 0)
      return EvalOutcome.fail(false, {
        comment: "no citation sources recorded",
      });
    const missingText = (expected.outputContains ?? []).filter(
      (text) => !output.output.includes(text),
    );
    if (missingText.length > 0)
      return EvalOutcome.fail(false, {
        comment: `output missing expected text: ${missingText.join(", ")}`,
      });
    const presentText = (expected.outputNotContains ?? []).filter((text) =>
      output.output.includes(text),
    );
    if (presentText.length > 0)
      return EvalOutcome.fail(false, {
        comment: `output contains forbidden text: ${presentText.join(", ")}`,
      });
    if (expected.requiresOutputNonEmpty && output.output.trim().length === 0)
      return EvalOutcome.fail(false, {
        comment: "agent produced no output",
      });
    return EvalOutcome.pass(true);
  },
};

export function toolCalled(
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

export function approvalsForTool(
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

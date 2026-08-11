import {
  defineEvalSuite,
  EvalOutcome,
  type EvalCase,
  type EvalMetric,
} from "@anvia/core/evals";
import { createBehaviorTarget } from "../behavior-target.js";
import { FIXTURE_CLARIFICATION_ANSWERS } from "../fixtures.js";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

const suite = defineEvalSuite<EvalCaseInput, BehaviorTrace>();

const cases: EvalCase<EvalCaseInput, unknown>[] = [
  {
    id: "ambiguous-prompt-asks",
    input: {
      prompt: "buatkan logo untuk perusahaan saya",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: false,
      },
      expected: { requiresClarification: true },
    },
  },
  {
    id: "clear-prompt-no-clarification",
    input: {
      prompt:
        "buatkan logo minimalis warna biru dengan ikon roket untuk startup fintech",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: false,
      },
      expected: { forbidsClarification: true },
    },
  },
  {
    id: "clarification-answers-respected",
    input: {
      prompt: "desain banner, saya suka gaya watercolor",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: false,
      },
      expected: { outputContains: ["watercolor"] },
    },
  },
];

export const clarificationSuite = defineEvalSuite({
  name: "clarification-consistency",
  cases,
  target: createBehaviorTarget(),
  metrics: [
    suite.defineMetric({
      name: "clarification_requested",
      dataType: "BOOLEAN",
      evaluate: ({ output }) => {
        const requested = output.clarifications.length > 0;
        return requested
          ? EvalOutcome.pass(true)
          : EvalOutcome.fail(false, {
              comment: "no clarification requested for an ambiguous prompt",
            });
      },
    }),
    suite.defineMetric({
      name: "no_unnecessary_clarification",
      dataType: "BOOLEAN",
      evaluate: ({ output }) => {
        const unnecessary = output.clarifications.length === 0;
        return unnecessary
          ? EvalOutcome.pass(true)
          : EvalOutcome.fail(false, {
              comment:
                "clarification requested even though the prompt was already specific",
            });
      },
    }),
    suite.defineMetric({
      name: "respects_answers",
      dataType: "BOOLEAN",
      evaluate: ({ output }) => {
        if (output.clarifications.length === 0) return EvalOutcome.pass(true);
        const askedTypes = new Set(
          output.clarifications.flatMap((c) =>
            c.questions.map((q) => q.type),
          ),
        );
        const expectedValues = Object.entries(FIXTURE_CLARIFICATION_ANSWERS)
          .filter(([type]) => askedTypes.has(type))
          .map(([, value]) => value);
        if (expectedValues.length === 0) return EvalOutcome.pass(true);
        const missing = expectedValues.filter(
          (value) => !output.output.includes(value),
        );
        return missing.length === 0
          ? EvalOutcome.pass(true)
          : EvalOutcome.fail(false, {
              comment: `auto-answer value not reflected in output: ${missing.join(", ")}`,
            });
      },
    }),
  ],
});

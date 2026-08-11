import {
  defineEvalSuite,
  EvalOutcome,
  type EvalCase,
} from "@anvia/core/evals";
import { createBehaviorTarget } from "../behavior-target.js";
import { FIXTURE_CLARIFICATION_ANSWERS } from "../fixtures.js";
import { expectationMetric } from "./helpers.js";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

const suite = defineEvalSuite<EvalCaseInput, BehaviorTrace>();

const ANSWERS_RESPECTED_CASE = "clarification-answers-respected";

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
    expectationMetric,
    suite.defineMetric({
      name: "respects_answers",
      dataType: "BOOLEAN",
      evaluate: ({ case: testCase, output }) => {
        if (testCase.id !== ANSWERS_RESPECTED_CASE) return EvalOutcome.pass(true);
        const askedIds = output.clarifications.flatMap((c) =>
          c.questions.map((q) => q.id),
        );
        if (askedIds.length === 0)
          return EvalOutcome.fail(false, {
            comment: "no clarification questions were asked",
          });
        const keyedAnswers = askedIds.flatMap((id) => {
          const value = FIXTURE_CLARIFICATION_ANSWERS[id];
          return value === undefined ? [] : [value];
        });
        if (keyedAnswers.length === 0) return EvalOutcome.pass(true);
        const missing = keyedAnswers.filter(
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

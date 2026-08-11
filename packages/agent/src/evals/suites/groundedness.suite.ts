import {
  defineEvalSuite,
  EvalOutcome,
  gEval,
  type EvalCase,
  type EvalMetric,
} from "@anvia/core/evals";
import { createCompletionModel } from "../../providers/openai.js";
import { createBehaviorTarget } from "../behavior-target.js";
import { evalConfig } from "../config.js";
import { FIXTURE_DOCUMENTS } from "../fixtures.js";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

const suite = defineEvalSuite<EvalCaseInput, BehaviorTrace>();

const ANSWERS_FROM_DOCS_CASE = "answers-from-docs";
const NO_FABRICATION_CASE = "no-fabrication-when-absent";

const FIXTURE_CHUNK_TEXTS = FIXTURE_DOCUMENTS.flatMap((document) =>
  document.chunks.map((chunk) => chunk.chunkText),
);

const cases: EvalCase<EvalCaseInput, unknown>[] = [
  {
    id: ANSWERS_FROM_DOCS_CASE,
    input: {
      prompt: "jelaskan kebijakan remote kerja di perusahaan",
      sessionConfig: {
        hasDocuments: true,
        webSearchEnabled: false,
        imageGenEnabled: false,
        approvalMode: "auto-approve",
      },
      expected: {
        requiresTools: ["search_document_pages"],
        requiresCitation: true,
        outputContains: ["remote-first"],
      },
    },
  },
  {
    id: NO_FABRICATION_CASE,
    input: {
      prompt: "apa kebijakan bonus tahunan?",
      sessionConfig: {
        hasDocuments: true,
        webSearchEnabled: false,
        imageGenEnabled: false,
      },
      expected: {},
    },
  },
];

const noFabricationJudge = gEval<
  EvalCaseInput,
  BehaviorTrace,
  unknown,
  "no_fabricated_bonus_policy"
>({
  name: "no_fabricated_bonus_policy",
  model: createCompletionModel(evalConfig.judgeModel),
  threshold: 0.7,
  evaluationParams: ["actualOutput", "context"],
  evaluationSteps: [
    "Identify any policy details, numbers, or rules the answer states about an annual bonus.",
    "Check whether each claimed detail appears in the provided context documents.",
    "Penalize invented bonus policy details, numbers, or rules that are not present in the context.",
    "Reward answers that say the documents do not cover annual bonuses or otherwise abstain.",
  ],
  context: () => FIXTURE_CHUNK_TEXTS,
});

const noFabricationMetric: EvalMetric<
  EvalCaseInput,
  BehaviorTrace,
  number,
  unknown,
  "no_fabricated_bonus_policy"
> = {
  ...noFabricationJudge,
  evaluate: (args) =>
    args.case.id === NO_FABRICATION_CASE
      ? noFabricationJudge.evaluate(args)
      : EvalOutcome.pass(1),
};

export const groundednessSuite = defineEvalSuite({
  name: "groundedness-and-citations",
  cases,
  target: createBehaviorTarget(),
  metrics: [
    suite.defineMetric({
      name: "citation_present",
      dataType: "BOOLEAN",
      evaluate: ({ case: testCase, output }) => {
        if (testCase.id !== ANSWERS_FROM_DOCS_CASE)
          return EvalOutcome.pass(true);
        return output.citations.length > 0
          ? EvalOutcome.pass(true)
          : EvalOutcome.fail(false, {
              comment: "no citation sources recorded for a document-grounded answer",
            });
      },
    }),
    suite.defineMetric({
      name: "contains_fixture_fact",
      dataType: "BOOLEAN",
      evaluate: ({ case: testCase, output }) => {
        if (testCase.id !== ANSWERS_FROM_DOCS_CASE)
          return EvalOutcome.pass(true);
        return output.output.includes("remote-first")
          ? EvalOutcome.pass(true)
          : EvalOutcome.fail(false, {
              comment: "answer does not contain the fixture fact 'remote-first'",
            });
      },
    }),
    suite.defineMetric({
      name: "tool_called_search_document_pages",
      dataType: "BOOLEAN",
      evaluate: ({ case: testCase, output }) => {
        if (testCase.id !== ANSWERS_FROM_DOCS_CASE)
          return EvalOutcome.pass(true);
        const called = output.toolCalls.some(
          (t) => t.name === "search_document_pages",
        );
        return called
          ? EvalOutcome.pass(true)
          : EvalOutcome.fail(false, {
              comment: "search_document_pages was never called",
            });
      },
    }),
    noFabricationMetric,
  ],
});

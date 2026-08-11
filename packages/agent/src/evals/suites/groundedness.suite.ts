import {
  defineEvalSuite,
  EvalOutcome,
  gEval,
  type EvalCase,
  type EvalMetric,
} from "@anvia/core/evals";
import {
  createCompletionModel,
  parseReasoningEffort,
  withReasoningEffort,
} from "../../providers/openai.js";
import { createBehaviorTarget } from "../behavior-target.js";
import { evalConfig } from "../config.js";
import { FIXTURE_DOCUMENTS } from "../fixtures.js";
import { expectationMetric } from "./helpers.js";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

export const NO_FABRICATION_CASE = "no-fabrication-when-absent";

const FIXTURE_CHUNK_TEXTS = FIXTURE_DOCUMENTS.flatMap((document) =>
  document.chunks.map((chunk) => chunk.chunkText),
);

const cases: EvalCase<EvalCaseInput, unknown>[] = [
  {
    id: "answers-from-docs",
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
  model: withReasoningEffort(
    createCompletionModel(evalConfig.judgeModel),
    parseReasoningEffort(evalConfig.judgeEffort) ?? "high",
  ),
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
  target: createBehaviorTarget("groundedness-and-citations"),
  metrics: [expectationMetric, noFabricationMetric],
});

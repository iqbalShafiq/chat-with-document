import type { EvalExpectations } from "@anvia/core/evals";
import {
  approvalImageExpectations,
  approvalImageSuite,
} from "./approval-image.suite.js";
import {
  approvalWebSearchExpectations,
  approvalWebSearchSuite,
} from "./approval-web-search.suite.js";
import { clarificationSuite } from "./clarification.suite.js";
import { toolChoiceSuite } from "./tool-choice.suite.js";
import { groundednessSuite } from "./groundedness.suite.js";
import { documentToolsSuite } from "./document-tools.suite.js";

export const EVAL_SUITES = {
  "approval-image": approvalImageSuite,
  "approval-web-search": approvalWebSearchSuite,
  clarification: clarificationSuite,
  "tool-choice": toolChoiceSuite,
  groundedness: groundednessSuite,
  "document-tools": documentToolsSuite,
} as const;

export const EVAL_EXPECTATIONS: Record<string, EvalExpectations> = {
  "approval-image": approvalImageExpectations,
  "approval-web-search": approvalWebSearchExpectations,
};

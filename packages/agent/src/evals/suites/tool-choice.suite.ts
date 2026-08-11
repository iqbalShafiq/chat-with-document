import {
  defineEvalSuite,
  EvalOutcome,
  type EvalCase,
  type EvalMetric,
} from "@anvia/core/evals";
import { createBehaviorTarget } from "../behavior-target.js";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

const suite = defineEvalSuite<EvalCaseInput, BehaviorTrace>();

const WEB_TOOLS = ["web_search", "web_fetch"] as const;
const DOCUMENT_TOOLS = ["find_documents", "search_document_pages"] as const;

function anyToolCalled(
  output: BehaviorTrace,
  toolNames: readonly string[],
): boolean {
  return output.toolCalls.some((t) =>
    (toolNames as readonly string[]).includes(t.name),
  );
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

/**
 * Future case, skipped in v1: library-docs-uses-context7 — a library/API
 * question with hasDocuments true should route to the context7 tools instead
 * of web_search. The context7 MCP server is env-gated and not part of the stub
 * scope, so it cannot be exercised by the behavior target yet.
 */
const cases: EvalCase<EvalCaseInput, unknown>[] = [
  {
    id: "out-of-scope-uses-web",
    input: {
      prompt: "berapa harga rata-rata laptop gaming di 2026?",
      sessionConfig: {
        webSearchEnabled: true,
        imageGenEnabled: false,
        hasDocuments: true,
        approvalMode: "auto-approve",
      },
      expected: { requiresTools: ["web_search"] },
    },
  },
  {
    id: "info-in-docs-no-web",
    input: {
      prompt: "berapa harga paket Pro?",
      sessionConfig: {
        webSearchEnabled: true,
        imageGenEnabled: false,
        hasDocuments: true,
        approvalMode: "auto-approve",
      },
      expected: {
        requiresTools: ["search_document_pages"],
        forbidsTools: ["web_search"],
        outputContains: ["29"],
      },
    },
  },
  {
    id: "no-docs-knowledge-question",
    input: {
      prompt: "apa ibukota Indonesia?",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: false,
      },
      expected: {},
    },
  },
];

export const toolChoiceSuite = defineEvalSuite({
  name: "tool-choice-initiative",
  cases,
  target: createBehaviorTarget(),
  metrics: [
    suite.defineMetric({
      name: "used_web_search",
      dataType: "BOOLEAN",
      evaluate: ({ output }) => {
        const used = anyToolCalled(output, WEB_TOOLS);
        return used
          ? EvalOutcome.pass(true)
          : EvalOutcome.fail(false, {
              comment: "agent never used web tools for an out-of-scope question",
            });
      },
    }),
    suite.defineMetric({
      name: "used_document_search",
      dataType: "BOOLEAN",
      evaluate: ({ output }) => {
        const used = anyToolCalled(output, DOCUMENT_TOOLS);
        return used
          ? EvalOutcome.pass(true)
          : EvalOutcome.fail(false, {
              comment: "agent never used document tools",
            });
      },
    }),
    suite.defineMetric({
      name: "no_web_when_docs_sufficient",
      dataType: "BOOLEAN",
      evaluate: ({ output }) => {
        const usedWeb = anyToolCalled(output, WEB_TOOLS);
        const searchedDocs = output.toolCalls.some(
          (t) => t.name === "search_document_pages",
        );
        if (!searchedDocs) return EvalOutcome.fail(false, {
          comment: "search_document_pages was never called",
        });
        return usedWeb
          ? EvalOutcome.fail(false, {
              comment:
                "agent called web tools although the document search already answered",
            })
          : EvalOutcome.pass(true);
      },
    }),
    suite.defineMetric({
      name: "no_find_documents_when_no_docs",
      dataType: "BOOLEAN",
      evaluate: ({ output }) => {
        const calledFind = output.toolCalls.some(
          (t) => t.name === "find_documents",
        );
        if (calledFind)
          return EvalOutcome.fail(false, {
            comment: "find_documents called even though no documents are attached",
          });
        return output.output.trim().length > 0
          ? EvalOutcome.pass(true)
          : EvalOutcome.fail(false, {
              comment: "agent produced no output",
            });
      },
    }),
    toolCalled("search_document_pages"),
    toolCalled("web_search"),
  ],
});

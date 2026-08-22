import { defineEvalSuite, type EvalCase } from "@anvia/core/evals";
import { createBehaviorTarget } from "../behavior-target.js";
import { expectationMetric } from "./helpers.js";
import type { BehaviorTrace, EvalCaseInput } from "../types.js";

/**
 * Tabular analysis tool-choice suite — stub backends, real EVAL_MODEL.
 * Covers read/analyze vs SQL choice, document-table discovery, and abstain
 * without a dataset. Uses the in-memory TABULAR_FIXTURE_SHEET /
 * DOCUMENT_TABLE_SHEET stubbed in behavior-target.ts.
 *
 * EVAL_MODEL default: deepseek/deepseek-v4-flash-0731 (via evalConfig).
 */

const cases: EvalCase<EvalCaseInput, unknown>[] = [
  {
    id: "average-revenue-by-region-analyze",
    input: {
      prompt:
        "My sales.csv is available for this chat — it has columns region, product, revenue, units (6 rows covering East, West, North, South). " +
        "Using the tabular analysis tools, what is the average revenue by region? " +
        "Please inspect the dataset first with read_dataset if helpful, then compute the average by region with analyze_dataset " +
        '(groupBy ["region"], metrics mean of revenue) and present a table and bar chart.',
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: true,
        approvalMode: "auto-approve",
      },
      expected: {
        requiresTools: ["analyze_dataset"],
        forbidsTools: ["query_dataset_sql"],
      },
    },
  },
  {
    id: "top-3-products-by-revenue-sql",
    input: {
      prompt:
        "I have sales.csv (columns product, revenue, units, region) linked to this session. " +
        "Tell me the top 3 products by total revenue. " +
        "Use whatever query you need — you can write a read-only SQL SELECT with query_dataset_sql " +
        "to GROUP BY product, ORDER BY SUM(revenue) DESC, LIMIT 3. Show the result as a table.",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: true,
        approvalMode: "auto-approve",
      },
      expected: {
        requiresTools: ["query_dataset_sql"],
      },
    },
  },
  {
    id: "document-table-extract-then-analyze",
    input: {
      prompt:
        "My document table-rich.pdf contains a GFM markdown table on page 0 (columns region, revenue) that was extracted from the PDF. " +
        "Use extract_document_tables to discover the tables in this session, then use analyze_dataset on the discovered document table " +
        '(source {type:"document_table", documentId:"doc-table-rich", pageIndex:0, tableIndex:0}) to compute the average revenue by region. ' +
        "Present the results as a table and a brief summary.",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: true,
        approvalMode: "auto-approve",
      },
      expected: {
        requiresTools: ["extract_document_tables", "analyze_dataset"],
        forbidsTools: ["query_dataset_sql"],
      },
    },
  },
  {
    id: "plain-math-no-tabular",
    input: {
      prompt: "What is 12 + 7? Answer directly with the number — no dataset is linked to this session and no tabular tool is needed.",
      sessionConfig: {
        webSearchEnabled: false,
        imageGenEnabled: false,
        hasDocuments: false,
        approvalMode: "auto-approve",
      },
      expected: {
        forbidsTools: ["read_dataset", "analyze_dataset", "query_dataset_sql", "extract_document_tables"],
        requiresOutputNonEmpty: true,
        outputContains: ["19"],
      },
    },
  },
];

export const tabularAnalysisSuite = defineEvalSuite({
  name: "tabular-analysis",
  cases,
  target: createBehaviorTarget("tabular-analysis"),
  metrics: [expectationMetric],
});

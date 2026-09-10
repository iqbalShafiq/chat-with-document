import { defineEvalSuite, type EvalCase } from "@anvia/core/evals";
import { createBehaviorTarget } from "../behavior-target.js";
import { expectationMetric } from "./helpers.js";
import type { EvalCaseInput } from "../types.js";

/**
 * Derived dataset suite — stub backends, real EVAL_MODEL.
 * Covers create_dataset (example, web copy, derivation), fetch_dataset_from_url,
 * anti-duplication, and a Deep Research run that builds a derived dataset.
 */

const autoApprove = {
  webSearchEnabled: false,
  imageGenEnabled: false,
  hasDocuments: true,
  approvalMode: "auto-approve",
} as const;

const cases: EvalCase<EvalCaseInput, unknown>[] = [
  {
    id: "synthetic-example-then-chart",
    input: {
      prompt:
        "I have no data file. Create a small synthetic sales example with create_dataset " +
        "(name 'contoh-penjualan', columns category and sales, 3 rows: kopi/120, teh/90, susu/150), " +
        "then verify it with read_dataset using source {type:'upload', documentId:'doc-derived-new'}, " +
        "then chart it with analyze_dataset (aggregate groupBy category, sum of sales). " +
        "Call each tool in order and only describe results the tools actually returned. " +
        "Label the answer as a synthetic example.",
      sessionConfig: { ...autoApprove },
      expected: {
        requiresTools: ["create_dataset", "read_dataset", "analyze_dataset"],
        requiresOutputNonEmpty: true,
        outputContains: ["synthetic"],
      },
    },
  },
  {
    id: "derive-from-existing-csv",
    input: {
      prompt:
        "My sales.csv is linked (documentId=doc-sales-csv, columns region, product, revenue, units). " +
        "Build a derived summary with create_dataset (name 'ringkas-region', columns region and revenue, " +
        "rows East/3400 and West/800) and pass derivedFrom {documentId:'doc-sales-csv'}. " +
        "Then verify with read_dataset on documentId 'doc-derived-new' and chart with analyze_dataset aggregate. " +
        "Call each tool in order and only describe results the tools actually returned. " +
        "Mention the parent file in the answer.",
      sessionConfig: { ...autoApprove },
      expected: {
        requiresTools: ["create_dataset", "read_dataset", "analyze_dataset"],
        requiresOutputNonEmpty: true,
      },
    },
  },
  {
    id: "fetch-url-then-chart",
    input: {
      prompt:
        "Download the public CSV at https://example.com/data.csv with fetch_dataset_from_url " +
        "(reason: need the data for a chart), then verify with read_dataset on documentId 'doc-derived-url', " +
        "then chart revenue by region with analyze_dataset. Cite the source URL in the answer.",
      sessionConfig: { ...autoApprove },
      expected: {
        requiresTools: ["fetch_dataset_from_url", "read_dataset", "analyze_dataset"],
        requiresApprovalFor: ["fetch_dataset_from_url"],
        requiresOutputNonEmpty: true,
        outputContains: ["https://example.com/data.csv"],
      },
    },
  },
  {
    id: "no-duplicate-derivation",
    input: {
      prompt:
        "My sales.csv is available for this chat (documentId=doc-sales-csv, columns region, product, revenue, units). " +
        "What is the average revenue by region? Analyze the existing dataset directly with analyze_dataset " +
        "(groupBy region, mean of revenue). Do NOT create a new dataset.",
      sessionConfig: { ...autoApprove },
      expected: {
        requiresTools: ["analyze_dataset"],
        forbidsTools: ["create_dataset", "fetch_dataset_from_url", "query_dataset_sql"],
      },
    },
  },
  {
    id: "stats-regression-on-dataset",
    input: {
      prompt:
        "My sales.csv is linked (documentId=doc-sales-csv, columns region, product, revenue, units). " +
        "Run analyze_dataset with operation {op:'stats', column:'revenue'} and then with " +
        "operation {op:'regression', x:'units', y:'revenue'}. Report the mean and the R². " +
        "Do all computation through analyze_dataset on the dataset.",
      sessionConfig: { ...autoApprove },
      expected: {
        requiresTools: ["analyze_dataset"],
        forbidsTools: ["create_dataset", "fetch_dataset_from_url", "query_dataset_sql"],
        requiresOutputNonEmpty: true,
      },
    },
  },
  {
    id: "deep-research-builds-derived-chart",
    input: {
      prompt:
        "Call the deep_research tool now to compare the linked sales.csv (documentId=doc-sales-csv) " +
        "with current web evidence. Inside the research, build a small derived summary with create_dataset " +
        "and chart it with analyze_dataset, then return a cited report that embeds one ```dataset-chart block " +
        "with the exact chart object. Do not ask a clarification question.",
      sessionConfig: {
        webSearchEnabled: true,
        deepResearchEnabled: true,
        imageGenEnabled: false,
        hasDocuments: true,
        approvalMode: "auto-approve",
      },
      expected: {
        requiresTools: ["deep_research"],
        requiresCitation: true,
        requiresOutputNonEmpty: true,
        outputContains: ["dataset-chart"],
      },
    },
  },
];

export const derivedDatasetsSuite = defineEvalSuite({
  name: "derived-datasets",
  cases,
  target: createBehaviorTarget("derived-datasets"),
  metrics: [expectationMetric],
});

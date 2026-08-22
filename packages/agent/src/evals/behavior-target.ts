import type { AnyTool, ToolApprovalsOptions } from "@anvia/core";
import type { EvalCase, EvalTarget } from "@anvia/core/evals";
import { TRANSPARENT_1X1_PNG_BASE64 } from "../e2e/image-e2e-helpers.js";
import { tracing } from "../tracing.js";
import {
  createClarificationTool,
  CLARIFICATION_INSTRUCTION,
} from "../tools/clarification.js";
import { createDocumentTools } from "../tools/documents.js";
import {
  buildImageGenerationInstruction,
  createImageGenerationTools,
} from "../tools/image-generation.js";
import {
  createWebSearchTools,
  WEB_SEARCH_INSTRUCTION,
} from "../tools/web-search.js";
import {
  createCompletionModel,
  parseReasoningEffort,
} from "../providers/openai.js";
import { evalConfig } from "./config.js";
import { runAgentAndCollect } from "./run-agent.js";
import {
  createAutoClarificationResponder,
  createFakePrisma,
  createStubChunkSearchService,
  createStubImageModel,
  createStubTavilyClient,
  createStubViewImageModel,
  createStubViewImageTool,
} from "./stub-scopes.js";
import type { BehaviorTrace, EvalCaseInput, SessionConfig } from "./types.js";
import { createTabularAnalysisTools, type DatasetResolver } from "../tools/tabular/tools.js";
import type { TabularSheet } from "../tools/tabular/types.js";
import { assertReadOnlySql } from "../tools/tabular/sql.js";

export const VISION_HELPER_INSTRUCTION =
  "Your model cannot receive image input directly. When you need to see what " +
  "an image actually looks like, call view_image — it returns an accurate " +
  "text description of the real pixels via a vision model.\n" +
  "Sources you can pass:\n" +
  "- imageId: a session image id from the active image context or session history, " +
  "or an image id returned by get_document_page_images (document charts, photos, diagrams)\n" +
  "- url: a public http(s) image URL (e.g. a logo or product photo from web_search / web_fetch)\n" +
  "get_document_page_images returns image metadata without the actual pixels " +
  "for your model; when the answer depends on visual content, pass the returned " +
  "image id to view_image to see it.\n" +
  "Prefer view_image over guessing visual details. External reference images " +
  "from the web are supported — do not assume view_image is limited to " +
  "conversation-only images.";

const TABULAR_FIXTURE_SHEET: TabularSheet = {
  name: "sales",
  columns: [
    { name: "region", type: "string" },
    { name: "product", type: "string" },
    { name: "revenue", type: "number" },
    { name: "units", type: "number" },
  ],
  rows: [
    ["East", "Widget A", 1200, 30],
    ["West", "Widget B", 800, 20],
    ["East", "Widget C", 1500, 40],
    ["North", "Widget A", 900, 25],
    ["South", "Widget B", 1100, 35],
    ["East", "Widget A", 700, 15],
  ],
};

const DOCUMENT_TABLE_SHEET: TabularSheet = {
  name: "doc-table-1",
  columns: [
    { name: "region", type: "string" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    ["East", 1200],
    ["West", 800],
    ["East", 1500],
    ["North", 900],
  ],
};

const TABULAR_CATALOG_INSTRUCTION =
  "Tabular datasets available in this session:\n" +
  "- Upload: sales.csv (documentId=doc-sales-csv, sheet=sales) " +
  "columns: region string, product string, revenue number, units number (6 rows)\n" +
  "- Document table: table-rich.pdf (documentId=doc-table-rich, pageIndex=0, tableIndex=0) " +
  "columns: region string, revenue number (4 rows) extracted as a GFM markdown table\n" +
  "Tool guidance:\n" +
  "- Use read_dataset with source {type:\"upload\", documentId:\"doc-sales-csv\"} to inspect sales.csv\n" +
  "- Use analyze_dataset with source {type:\"upload\", documentId:\"doc-sales-csv\"} and operation {op:\"aggregate\", groupBy:[\"region\"], metrics:[{column:\"revenue\", fn:\"mean\"}]} for \"average revenue by region\"\n" +
  "- Use query_dataset_sql with source {type:\"upload\", documentId:\"doc-sales-csv\"} for ad-hoc SQL (SELECT ...) when you need a custom ranked query\n" +
  "- Use extract_document_tables (no args) to discover document tables, then analyze_dataset with source {type:\"document_table\", documentId:\"doc-table-rich\", pageIndex:0, tableIndex:0}\n" +
  "Only use dataset ids listed above — do not invent ids.";

const TABULAR_EMPTY_INSTRUCTION =
  "(No tabular datasets are linked to this session. " +
  "Do not call read_dataset, analyze_dataset, query_dataset_sql, or extract_document_tables — " +
  "answer from general knowledge or say the dataset is missing.)";

function createStubTabularResolver(hasDocuments: boolean): DatasetResolver {
  if (!hasDocuments) {
    return {
      async listUploads() {
        return [];
      },
      async resolveSheet() {
        throw new Error("Dataset not found or empty — no tabular datasets are linked to this session");
      },
      async listDocumentTables() {
        return [];
      },
    };
  }
  return {
    async listUploads() {
      return [
        {
          documentId: "doc-sales-csv",
          filename: "sales.csv",
          sheets: [
            {
              name: TABULAR_FIXTURE_SHEET.name,
              columns: TABULAR_FIXTURE_SHEET.columns,
              rowCount: TABULAR_FIXTURE_SHEET.rows.length,
            },
          ],
        },
      ];
    },
    async resolveSheet(ref) {
      if (ref.type === "document_table") return DOCUMENT_TABLE_SHEET;
      return TABULAR_FIXTURE_SHEET;
    },
    async listDocumentTables() {
      return [
        {
          documentId: "doc-table-rich",
          filename: "table-rich.pdf",
          pageIndex: 0,
          tableIndex: 0,
          columns: DOCUMENT_TABLE_SHEET.columns,
          rowCount: DOCUMENT_TABLE_SHEET.rows.length,
        },
      ];
    },
  };
}

function createStubSqlRunner() {
  return async (
    sheet: TabularSheet,
    query: string,
    opts?: { maxRows?: number },
  ) => {
    const maxRows = opts?.maxRows ?? 500;
    assertReadOnlySql(query);
    const lower = query.toLowerCase();
    const hasProduct = sheet.columns.some((c) => c.name === "product");
    const hasRevenue = sheet.columns.some((c) => c.name === "revenue");
    if (hasProduct && hasRevenue && lower.includes("product") && (lower.includes("group by") || lower.includes("order by") || lower.includes("limit"))) {
      const productIdx = sheet.columns.findIndex((c) => c.name === "product");
      const revenueIdx = sheet.columns.findIndex((c) => c.name === "revenue");
      const agg = new Map<string, number>();
      for (const row of sheet.rows) {
        const prod = String(row[productIdx] ?? "");
        const rev = typeof row[revenueIdx] === "number" ? (row[revenueIdx] as number) : Number(row[revenueIdx]) || 0;
        agg.set(prod, (agg.get(prod) ?? 0) + rev);
      }
      const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxRows);
      const limitMatch = lower.match(/limit\s+(\d+)/);
      const limit = limitMatch ? Math.min(Number(limitMatch[1]), sorted.length) : sorted.length;
      const sliced = sorted.slice(0, limit);
      return {
        columns: ["product", "total_revenue"],
        rows: sliced,
        rowCount: sliced.length,
        truncated: false,
      };
    }
    const columns = sheet.columns.map((c) => c.name);
    const rows = sheet.rows.slice(0, maxRows) as (string | number | null)[][];
    return { columns, rows, rowCount: rows.length, truncated: sheet.rows.length > maxRows };
  };
}

export function buildEvalTools(sessionConfig: SessionConfig): {
  tools: AnyTool[];
  instructions: string[];
  approvals: ToolApprovalsOptions | undefined;
} {
  const tools: AnyTool[] = [];
  const instructions: string[] = [];

  if (sessionConfig.hasDocuments) {
    tools.push(...createDocumentTools({
      userId: "eval-user", sessionId: "eval-session", projectId: null,
      prisma: createFakePrisma(), searchService: createStubChunkSearchService(),
      // Text-only models crash on tool-result image bytes (the completion
      // gateway rejects image input), so the tool drops the bytes for them:
      // get_document_page_images then returns the image id + markdown only,
      // which is exactly the "image exists but I cannot see it" state that
      // should route the model to view_image. Mirrors build-run-input.
      includeImageBytes: sessionConfig.visionModelAvailable !== false,
      fetchPageImage: async () =>
        new Uint8Array(Buffer.from(TRANSPARENT_1X1_PNG_BASE64, "base64")),
    }));
  }

  // Tabular tools are always registered (mirrors build-run-input.ts which wires
  // them unconditionally); the stub resolver returns empty/error when no dataset
  // is linked so the "abstain" case can be scored without crashes.
  tools.push(
    ...createTabularAnalysisTools({
      resolver: createStubTabularResolver(Boolean(sessionConfig.hasDocuments)),
      sqlRunner: createStubSqlRunner() as never,
    }),
  );
  instructions.push(sessionConfig.hasDocuments ? TABULAR_CATALOG_INSTRUCTION : TABULAR_EMPTY_INSTRUCTION);

  tools.push(...createWebSearchTools({
    tavilyClient: createStubTavilyClient(),
    enabled: sessionConfig.webSearchEnabled,
  }));
  instructions.push(WEB_SEARCH_INSTRUCTION);

  tools.push(...createImageGenerationTools({
    model: createStubImageModel(),
    store: {
      saveGeneratedImage: async () => ({
        id: "eval-img-1",
        mediaType: "image/png",
        width: 1024,
        height: 1024,
        modelId: "fixture/image",
        prompt: "eval fixture image",
      }),
    },
    enabled: sessionConfig.imageGenEnabled,
    hasGrant: () => false,
    takeToolOverride: () => null,
    userId: "eval-user", sessionId: "eval-session", projectId: null,
    resolveReference: async () => null,
    capabilities: () => null,
  }));
  instructions.push(buildImageGenerationInstruction({ webSearchAvailable: true }));

  tools.push(createClarificationTool({ requester: createAutoClarificationResponder() }));
  instructions.push(CLARIFICATION_INSTRUCTION);

  // Universal view_image: non-vision always gets description mode; vision gets vision mode when web search is available.
  // In eval, web search is always available via stubTavilyClient, so vision models also receive view_image for web images.
  let viewImageRegistered = false;
  if (!sessionConfig.visionModelAvailable) {
    tools.push(createStubViewImageTool({ model: createStubViewImageModel() }));
    if (!viewImageRegistered) instructions.push(VISION_HELPER_INSTRUCTION);
    viewImageRegistered = true;
  }
  if (sessionConfig.visionModelAvailable && !viewImageRegistered) {
    tools.push(createStubViewImageTool({ model: createStubViewImageModel() }));
    instructions.push(VISION_HELPER_INSTRUCTION);
    viewImageRegistered = true;
  }

  const needsApprovals = !sessionConfig.webSearchEnabled || !sessionConfig.imageGenEnabled;
  const approvals: ToolApprovalsOptions | undefined = needsApprovals
    ? { handler: async (request) => {
        const mode = sessionConfig.approvalMode ?? "auto-approve";
        return { approved: mode === "auto-approve" };
      } }
    : undefined;

  return { tools, instructions, approvals };
}

export function createBehaviorTarget(
  suiteName?: string,
): EvalTarget<EvalCaseInput, BehaviorTrace> {
  return async (input: EvalCaseInput, testCase: EvalCase<EvalCaseInput>) => {
    const { tools, instructions, approvals } = buildEvalTools(input.sessionConfig);
    const langfuseConfigured = Boolean(
      process.env.LANGFUSE_BASE_URL &&
        process.env.LANGFUSE_PUBLIC_KEY &&
        process.env.LANGFUSE_SECRET_KEY,
    );
    return runAgentAndCollect({
      prompt: input.prompt,
      sessionConfig: input.sessionConfig,
      model: createCompletionModel(input.sessionConfig.models?.[0] ?? evalConfig.model),
      reasoningEffort: parseReasoningEffort(evalConfig.modelEffort) ?? "max",
      tools,
      instructions,
      ...(approvals ? { approvals } : {}),
      ...(langfuseConfigured ? { tracing } : {}),
      ...(suiteName ? { suiteName } : {}),
      caseId: testCase.id,
    });
  };
}

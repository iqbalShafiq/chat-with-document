/**
 * Headed real-LLM E2E for the tabular data analysis feature (Plan 1, P1-C1..C8).
 * Uploads the fixtures in `e2e/fixtures/` and drives the real agent via the UI.
 *
 * Note on tool panels: ToolActivityPanel auto-collapses when a tool finishes,
 * so assertions expand the assistant's tool panels first (see helpers).
 */
import { expect, test } from "@playwright/test";
import {
  expandAssistantToolPanels,
  openFreshChat,
  sendMessage,
  uploadAndAsk,
  waitForRunDone,
  waitForStreaming,
} from "./helpers";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_TABLE = '[aria-label="Data table"]';
const BAR_CHART = '[role="img"][aria-label*="bar chart"]';
const SCATTER_CHART = '[role="img"][aria-label*="scatter"]';
const __e2eDir = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIR = path.resolve(__e2eDir, "../../../.playwright-mcp/data-analysis");

function ensureMcpDir(): void {
  fs.mkdirSync(MCP_DIR, { recursive: true });
}
async function saveEvidence(page: import("@playwright/test").Page, caseId: string): Promise<void> {
  ensureMcpDir();
  await page.screenshot({
    path: path.join(MCP_DIR, `${caseId}.png`),
    scale: "css",
    mask: [page.locator("article"), page.locator("nav")],
  });
  const hasTable = await page.locator('[aria-label="Data table"]').count();
  const hasBar = await page.locator('[role="img"][aria-label*="bar chart"]').count();
  const hasScatter = await page.locator('[role="img"][aria-label*="scatter"]').count();
  const chartCount = await page.locator('[role="img"]').count();
  const yml = `# ${caseId} — redacted headed evidence
# prompts, outputs, reasoning, tool arguments, and dataset contents are omitted
# hasTable=${hasTable} hasBar=${hasBar} hasScatter=${hasScatter}
# path: ${new URL(page.url()).pathname}
# chartCount=${chartCount}
`;
  fs.writeFileSync(path.join(MCP_DIR, `${caseId}.yml`), yml, "utf8");
  const consoleLog = `Case ${caseId}
path=${new URL(page.url()).pathname}
hasTable=${hasTable} hasBar=${hasBar} hasScatter=${hasScatter}
chartCount=${chartCount}
`;
  fs.writeFileSync(path.join(MCP_DIR, `${caseId}.console.log`), consoleLog, "utf8");
}

test("P1-C1: CSV upload -> read_dataset preview renders a DataTable", async ({ page }) => {
  test.setTimeout(360_000);
  await openFreshChat(page);
  await uploadAndAsk(
    page,
    "sales.csv",
    "Inspect my uploaded sales.csv with the read_dataset tool and tell me what columns it has and how many rows.",
  );
  await expandAssistantToolPanels(page);
  await expect(page.locator(DATA_TABLE).last()).toBeVisible();
  await saveEvidence(page, "P1-C1");
});

test("P1-C2: aggregate + bar chart", async ({ page }) => {
  test.setTimeout(360_000);
  await openFreshChat(page);
  await uploadAndAsk(
    page,
    "sales.csv",
    "Use the analyze_dataset tool: give me the average revenue per region as a table AND a bar chart.",
  );
  await expandAssistantToolPanels(page);
  await expect(page.locator(DATA_TABLE).last()).toBeVisible();
  await expect(page.locator(BAR_CHART).last()).toBeVisible();
  await saveEvidence(page, "P1-C2");
});

test("P1-C3: correlation + scatter chart", async ({ page }) => {
  test.setTimeout(360_000);
  await openFreshChat(page);
  await uploadAndAsk(
    page,
    "sales.csv",
    "Use the analyze_dataset tool to correlate the revenue and units columns and show the scatter chart.",
  );
  await expandAssistantToolPanels(page);
  await expect(page.locator(SCATTER_CHART).last()).toBeVisible();
  await saveEvidence(page, "P1-C3");
});

test("P1-C4: SQL query returns a table", async ({ page }) => {
  test.setTimeout(360_000);
  await openFreshChat(page);
  await uploadAndAsk(
    page,
    "sales.csv",
    "Use the query_dataset_sql tool on the sales dataset's sales.csv sheet: SELECT product, SUM(revenue) as total_revenue FROM sales GROUP BY product ORDER BY SUM(revenue) DESC LIMIT 3 — return the top 3 products by total revenue.",
  );
  await expandAssistantToolPanels(page);
  await expect(page.locator(DATA_TABLE).last()).toBeVisible();
  await saveEvidence(page, "P1-C4");
});

test("P1-C5: XLSX multi-sheet", async ({ page }) => {
  test.setTimeout(360_000);
  await openFreshChat(page);
  await uploadAndAsk(
    page,
    "multi-sheet.xlsx",
    "My workbook has a Summary and a Detail sheet. Use the read_dataset tool on the Detail sheet and show its columns.",
  );
  await expandAssistantToolPanels(page);
  await expect(page.locator(DATA_TABLE).last()).toBeVisible();
  await saveEvidence(page, "P1-C5");
});

test("P1-C6: PDF table extraction", async ({ page }) => {
  test.setTimeout(420_000);
  await openFreshChat(page);
  await uploadAndAsk(
    page,
    "table-rich.pdf",
    "Use the extract_document_tables tool on my document, then use the read_dataset tool on the first table it found and show its columns and rows.",
  );
  await expandAssistantToolPanels(page);
  await expect(page.locator(DATA_TABLE).last()).toBeVisible();
  await saveEvidence(page, "P1-C6");
});

test("P1-C7: no tabular source -> answers without analysis tools", async ({ page }) => {
  test.setTimeout(360_000);
  await openFreshChat(page);
  await sendMessage(page, "Analyze the numbers: what is 12 + 7?");
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.locator("article").last()).toContainText(/19/);
  await saveEvidence(page, "P1-C7");
});

test("P1-C8: chart/table renders mid-chat between user message and assistant text", async ({
  page,
}) => {
  test.setTimeout(360_000);
  await openFreshChat(page);
  await uploadAndAsk(
    page,
    "sales.csv",
    "Use the analyze_dataset tool: average revenue per region, please.",
  );
  await expandAssistantToolPanels(page);
  const chart = page.locator(BAR_CHART).last();
  await expect(chart).toBeVisible();
  const userMsg = page.locator("article").first();
  const assistant = page.locator("article").last();
  const chartBox = await chart.boundingBox();
  const userBox = await userMsg.boundingBox();
  const asstBox = await assistant.boundingBox();
  expect(chartBox!.y).toBeGreaterThan(userBox!.y);
  expect(chartBox!.y).toBeLessThan(asstBox!.y! + asstBox!.height!);
  await saveEvidence(page, "P1-C8");
});

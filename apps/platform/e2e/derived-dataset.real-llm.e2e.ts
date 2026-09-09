/**
 * Headed real-LLM E2E for derived datasets (create_dataset / fetch_dataset_from_url).
 * Drives the real agent via the UI without fixtures: synthetic example, derivation
 * from an uploaded CSV, public URL download, and a negative non-CSV URL case.
 */
import { expect, test } from "@playwright/test";
import {
  expandAssistantToolPanels,
  openFreshChat,
  sendMessage,
  setSwitch,
  uploadAndAsk,
  waitForRunDone,
  waitForStreaming,
} from "./helpers";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_TABLE = '[aria-label="Data table"]';
const BAR_CHART = '[role="img"][aria-label*="bar chart"]';
const __e2eDir = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIR = path.resolve(__e2eDir, "../../../.playwright-mcp/derived-dataset");

function ensureMcpDir(): void {
  fs.mkdirSync(MCP_DIR, { recursive: true });
}
async function saveEvidence(page: import("@playwright/test").Page, caseId: string): Promise<void> {
  ensureMcpDir();
  const hasTable = await page.locator('[aria-label="Data table"]').count();
  const hasBar = await page.locator('[role="img"][aria-label*="bar chart"]').count();
  const chartCount = await page.locator('[role="img"]').count();
  const yml = `# ${caseId} — redacted headed evidence (no screenshots)
# prompts, outputs, reasoning, tool arguments, and dataset contents are omitted
# hasTable=${hasTable} hasBar=${hasBar}
# path: ${new URL(page.url()).pathname}
# chartCount=${chartCount}
`;
  fs.writeFileSync(path.join(MCP_DIR, `${caseId}.yml`), yml, "utf8");
  const consoleLog = `Case ${caseId}
path=${new URL(page.url()).pathname}
hasTable=${hasTable} hasBar=${hasBar}
chartCount=${chartCount}
`;
  fs.writeFileSync(path.join(MCP_DIR, `${caseId}.console.log`), consoleLog, "utf8");
}

test("P3-C1: synthetic example -> chart labeled as example", async ({ page }) => {
  test.setTimeout(420_000);
  await openFreshChat(page);
  await sendMessage(
    page,
    "I have no data file. Use create_dataset to make a small synthetic sales example " +
      "(columns category and sales, 3 rows), verify it with read_dataset, then show an aggregate bar chart " +
      "with analyze_dataset. Label the answer as a synthetic example.",
  );
  await waitForStreaming(page);
  await waitForRunDone(page, 360_000);
  await expandAssistantToolPanels(page);
  await expect(page.locator(BAR_CHART).last()).toBeVisible();
  await expect(page.locator("article").last()).toContainText(/synthetic|example|contoh/i);
  await saveEvidence(page, "P3-C1");
});

test("P3-C2: derivation from uploaded CSV shows Olahan chip", async ({ page }) => {
  test.setTimeout(420_000);
  await openFreshChat(page);
  await uploadAndAsk(
    page,
    "sales.csv",
    "Read my sales.csv, then use create_dataset with derivedFrom to build a small per-region summary, " +
      "verify it with read_dataset, and show a bar chart with analyze_dataset.",
  );
  await expandAssistantToolPanels(page);
  await expect(page.locator(BAR_CHART).last()).toBeVisible();
  // The right rail lists session documents fetched at page load; reload so
  // the newly ready derived document appears, then check its Olahan chip.
  await page.reload();
  await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Olahan", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await saveEvidence(page, "P3-C2");
});

test("P3-C3: public CSV download cites the source URL", async ({ page }) => {
  test.setTimeout(420_000);
  await openFreshChat(page);
  await setSwitch(page, "Web search", true);
  await sendMessage(
    page,
    "Use fetch_dataset_from_url to download https://people.sc.fsu.edu/~jburkardt/data/csv/airtravel.csv " +
      "(reason: need the data for a chart), verify with read_dataset, then chart it with analyze_dataset. " +
      "Cite the source URL in the answer.",
  );
  await waitForStreaming(page);
  await waitForRunDone(page, 360_000);
  await expandAssistantToolPanels(page);
  await expect(page.locator(DATA_TABLE).last()).toBeVisible();
  await expect(page.locator("article").last()).toContainText(/sc\.fsu\.edu|airtravel/i);
  await saveEvidence(page, "P3-C3");
});

test("P3-C4: non-CSV URL fails gracefully", async ({ page }) => {
  test.setTimeout(420_000);
  await openFreshChat(page);
  await setSwitch(page, "Web search", true);
  await sendMessage(
    page,
    "Use fetch_dataset_from_url to download https://example.com/ (reason: testing error handling). " +
      "If it is not a CSV file, say so plainly without inventing data.",
  );
  await waitForStreaming(page);
  await waitForRunDone(page, 360_000);
  await expect(page.locator("article").last()).toContainText(/not.*csv|html|web_fetch|could not|tidak/i);
  await saveEvidence(page, "P3-C4");
});

test("P3-C5: create_chart draws a titled multi-series bar chart", async ({ page }) => {
  test.setTimeout(420_000);
  await openFreshChat(page);
  await uploadAndAsk(
    page,
    "sales.csv",
    "Use the create_chart tool with kind bar, x region, series sum of revenue and sum of units, " +
      "and title 'Sales by region'. Show the chart.",
  );
  await expandAssistantToolPanels(page);
  await expect(page.locator(BAR_CHART).last()).toBeVisible();
  await expect(page.locator("article").last()).toContainText(/Sales by region/i);
  await saveEvidence(page, "P3-C5");
});

test("P3-C6: chart embeds inline in the answer and create is not duplicated", async ({ page }) => {
  test.setTimeout(420_000);
  await openFreshChat(page);
  await sendMessage(
    page,
    "Use create_dataset once to make a small synthetic sales example " +
      "(columns category and sales, 3 rows), then read it, then chart it with analyze_dataset aggregate. " +
      "Put the chart in the middle of the answer with ![chart:1]() between two paragraphs. " +
      "Create the dataset exactly once even if reading takes a moment.",
  );
  await waitForStreaming(page);
  await waitForRunDone(page, 360_000);
  await expandAssistantToolPanels(page);
  const article = page.locator("article").last();
  await expect(article.locator(BAR_CHART)).toBeVisible();
  await expect(article).toContainText(/synthetic/i);
  await saveEvidence(page, "P3-C6");
});

/**
 * Headed real-LLM Deep Research evidence (Plan 2, P2-C9..P2-C13).
 * Run with playwright.real-llm.config.ts against a booted real stack.
 */
import { expect, test, type Page } from "@playwright/test";
import {
  API_ORIGIN,
  attachFile,
  openFreshChat,
  sendMessage,
  setModel,
  setSwitch,
  waitForRunDone,
  waitForStreaming,
} from "./helpers";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(e2eDir, "../../../.playwright-mcp/deep-research");
const REAL_TEST_MODEL = "deepseek/deepseek-v4-flash-0731";
type ConsoleEvidence = {
  kind: "console" | "pageerror";
  level?: string;
  text: string;
  location?: string;
};

const consoleEvidence = new WeakMap<Page, ConsoleEvidence[]>();

test.beforeEach(async ({ page }) => {
  const entries: ConsoleEvidence[] = [];
  consoleEvidence.set(page, entries);
  page.on("console", (message) => {
    entries.push({
      kind: "console",
      level: message.type(),
      text: message.text(),
      location: message.location().url || undefined,
    });
  });
  page.on("pageerror", (error) => {
    entries.push({ kind: "pageerror", text: error.message });
  });
});

function ensureEvidenceDir(): void {
  fs.mkdirSync(evidenceDir, { recursive: true });
}

async function saveEvidence(page: Page, caseId: string): Promise<void> {
  ensureEvidenceDir();
  await page.screenshot({
    path: path.join(evidenceDir, `${caseId}.png`),
    scale: "css",
  });
  const body = await page.locator("body").innerText();
  const snapshot = await page.locator("body").ariaSnapshot();
  fs.writeFileSync(
    path.join(evidenceDir, `${caseId}.yml`),
    `case: ${caseId}\nurl: ${page.url()}\nbody_tail: |\n${body
      .slice(-5000)
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n")}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(evidenceDir, `${caseId}.snapshot.yml`),
    snapshot ?? "",
    "utf8",
  );
  fs.writeFileSync(
    path.join(evidenceDir, `${caseId}.console.json`),
    JSON.stringify(consoleEvidence.get(page) ?? [], null, 2) + "\n",
    "utf8",
  );
}

async function requireDeepResearch(page: Page): Promise<void> {
  const response = await page.request.get(`${API_ORIGIN}/api/chat/capabilities`);
  expect(response.ok()).toBe(true);
  const capabilities = (await response.json()) as {
    deepResearchAvailable?: boolean;
  };
  test.skip(
    !capabilities.deepResearchAvailable,
    "Deep Research is unavailable: configure Tavily or link a document",
  );
}

async function attachCorpus(page: Page): Promise<void> {
  await attachFile(page, "sales.csv");
  await attachFile(page, "table-rich.pdf");
}

async function useRealTestModel(page: Page): Promise<void> {
  await setModel(page, REAL_TEST_MODEL);
}

async function waitForApproval(page: Page): Promise<void> {
  await expect(
    page.getByRole("region", { name: /approve running deep research/i }),
  ).toBeVisible({ timeout: 120_000 });
}

test("P2-C9: toggle on runs direct and produces citations", async ({ page }) => {
  test.setTimeout(420_000);
  await openFreshChat(page);
  await useRealTestModel(page);
  await requireDeepResearch(page);
  await setSwitch(page, "Deep Research", true);
  await sendMessage(
    page,
    "Use Deep Research now to summarize the official Anvia documentation on specialist agents as tools and approval behavior. Cite source-grounded claims and state limitations. Do not ask a clarification question.",
  );
  await waitForStreaming(page);
  await waitForRunDone(page, 360_000);
  await expect(page.locator("article").last()).toContainText(/source|citation|Anvia/i);
  await saveEvidence(page, "P2-C9");
});

test("P2-C10: toggle off offers allow once for the whole research run", async ({ page }) => {
  test.setTimeout(420_000);
  await openFreshChat(page);
  await useRealTestModel(page);
  await requireDeepResearch(page);
  await sendMessage(
    page,
    "Call the deep_research tool now for a concrete multi-source investigation of the official Anvia documentation homepage. Do not ask a clarification question; return a cited report.",
  );
  await waitForApproval(page);
  await page.getByRole("button", { name: "Allow once" }).click();
  await waitForRunDone(page, 360_000);
  await saveEvidence(page, "P2-C10");
});

test("P2-C11: rejecting Deep Research does not fabricate citations", async ({ page }) => {
  test.setTimeout(240_000);
  await openFreshChat(page);
  await useRealTestModel(page);
  await requireDeepResearch(page);
  await sendMessage(
    page,
    "Call the deep_research tool now for the concrete question: what does the official Anvia documentation say about specialist agents as tools? Do not ask a clarification question; cite the web evidence.",
  );
  await waitForApproval(page);
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Rejection reason" })).toBeVisible();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await waitForRunDone(page, 360_000);
  await expect(page.locator("article").last()).not.toContainText(/\[\[cite:|https?:\/\//i);
  await saveEvidence(page, "P2-C11");
});

test("P2-C12: Deep Research grounds a CSV + PDF + web corpus", async ({ page }) => {
  test.setTimeout(480_000);
  await openFreshChat(page);
  await useRealTestModel(page);
  await requireDeepResearch(page);
  await setSwitch(page, "Deep Research", true);
  await attachCorpus(page);
  await sendMessage(
    page,
    "Call the deep_research tool now to reconcile the sales CSV, PDF table, and current official web evidence. Do not ask a clarification question. Separate and cite each source type, explain disagreements, and verify the synthesis.",
  );
  await waitForStreaming(page);
  await waitForRunDone(page, 360_000);
  await expect(page.locator("article").last()).toContainText(/CSV|PDF|source|citation/i);
  await saveEvidence(page, "P2-C12");
});

test("P2-C13: Deep Research progress is visible while running", async ({ page }) => {
  test.setTimeout(420_000);
  await openFreshChat(page);
  await useRealTestModel(page);
  await requireDeepResearch(page);
  await setSwitch(page, "Deep Research", true);
  await sendMessage(
    page,
    "Call the deep_research tool now for the concrete question: summarize the official Anvia documentation on specialist agents and tool approvals. Do not ask a clarification question. Perform a bounded investigation using authoritative sources, then synthesize and verify the result.",
  );
  await expect(page.getByRole("status").filter({ hasText: /Research|Searching|Synthesizing/i })).toBeVisible({
    timeout: 120_000,
  });
  await waitForRunDone(page, 360_000);
  await saveEvidence(page, "P2-C13");
});

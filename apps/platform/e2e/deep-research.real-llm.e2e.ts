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
  setSwitch,
  waitForRunDone,
  waitForStreaming,
} from "./helpers";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const e2eDir = path.dirname(fileURLToPath(import.meta.url));
const evidenceDir = path.resolve(e2eDir, "../../../.playwright-mcp/deep-research");
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
    mask: [page.locator("article"), page.locator("nav")],
  });
  const entries = consoleEvidence.get(page) ?? [];
  const safeSummary = {
    caseId,
    url: new URL(page.url()).pathname,
    researchActivityCount: await page
      .getByRole("button", { name: /Deep Research/i })
      .count(),
    consoleErrorCount: entries.filter(
      (entry) => entry.kind === "pageerror" || entry.level === "error",
    ).length,
  };
  fs.writeFileSync(
    path.join(evidenceDir, `${caseId}.yml`),
    `case: ${caseId}\npath: ${safeSummary.url}\nresearch_activity_count: ${safeSummary.researchActivityCount}\nconsole_error_count: ${safeSummary.consoleErrorCount}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(evidenceDir, `${caseId}.snapshot.yml`),
    `# Redacted evidence: prompts, outputs, reasoning, and tool arguments are intentionally omitted.\ncase: ${caseId}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(evidenceDir, `${caseId}.console.json`),
    JSON.stringify(safeSummary, null, 2) + "\n",
    "utf8",
  );
}

async function requireDeepResearch(page: Page): Promise<void> {
  const response = await page.request.get(`${API_ORIGIN}/api/chat/capabilities`);
  expect(response.ok()).toBe(true);
  const capabilities = (await response.json()) as {
    deepResearchAvailable?: boolean;
  };
  expect(
    capabilities.deepResearchAvailable,
    "real Deep Research capability is required",
  ).toBe(true);
}

async function attachCorpus(page: Page): Promise<void> {
  await attachFile(page, "sales.csv");
  await attachFile(page, "table-rich.pdf");
}

async function waitForApproval(page: Page): Promise<void> {
  await expect(
    page.getByRole("region", { name: /approve running deep research/i }),
  ).toBeVisible({ timeout: 120_000 });
}

test("P2-C9: toggle on runs direct and produces citations", async ({ page }) => {
  test.setTimeout(420_000);
  await openFreshChat(page);
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
  // Nested research is capped at six minutes. Parent planning and the
  // reasoning-max synthesis turn after the report still need a visible
  // terminal frame; do not raise the production child budget.
  test.setTimeout(720_000);
  await openFreshChat(page);
  await requireDeepResearch(page);
  await setSwitch(page, "Deep Research", true);
  await attachCorpus(page);
  await sendMessage(
    page,
    "Call the deep_research tool now to reconcile the sales CSV, PDF table, and current official web evidence. Use at most four retrieval/tool calls total: inspect the CSV once, the PDF once, and use the remaining calls for one authoritative web source. Do not ask a clarification question. Return a concise comparison that cites each source type, explains disagreements, and verifies the synthesis.",
  );
  await waitForStreaming(page);
  await waitForRunDone(page, 600_000);
  await expect(page.locator("article").last()).toContainText(/CSV|PDF|source|citation/i);
  await saveEvidence(page, "P2-C12");
});

test("P2-C13: Deep Research progress is visible while running", async ({ page }) => {
  test.setTimeout(540_000);
  await openFreshChat(page);
  await requireDeepResearch(page);
  await setSwitch(page, "Deep Research", true);
  await sendMessage(
    page,
    "Call the deep_research tool now for the concrete question: summarize the official Anvia documentation on specialist agents and tool approvals. Do not ask a clarification question. Perform a bounded investigation using authoritative sources, then synthesize and verify the result.",
  );
  await expect(page.locator('p[role="status"][aria-live="polite"]').filter({
    hasText: /Research|Searching|Synthesizing/i,
  })).toBeVisible({
    timeout: 120_000,
  });
  const secondApproval = page.getByRole("region", {
    name: /approve searching the web/i,
  });
  await expect
    .poll(
      async () => {
        if ((await secondApproval.count()) > 0) {
          throw new Error(
            "parent opened a second retrieval approval after Deep Research",
          );
        }
        return page.getByRole("button", { name: "Send", exact: true }).isVisible();
      },
      { timeout: 480_000 },
    )
    .toBe(true);
  await expect(secondApproval).toHaveCount(0);
  await saveEvidence(page, "P2-C13");
});

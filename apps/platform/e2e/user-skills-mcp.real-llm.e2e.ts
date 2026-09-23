/**
 * User Skills + self-serve MCP acceptance with the real stack and real LLM.
 * Prerequisites (see plan docs/superpowers/plans/2026-09-23-user-skills-mcp.md):
 *   - `pnpm dev` running (API :3001, platform :3000, worker) with
 *     OPENAI_BASE_URL=https://openrouter.ai/api/v1 and a real OPENAI_API_KEY.
 *   - Run: `pnpm --filter @anreal/platform exec playwright test --config playwright.real-llm.config.ts e2e/user-skills-mcp.real-llm.e2e.ts`
 * Signs in as shafiq@testing.com (registers first when missing).
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ORIGIN,
  expandAssistantToolPanels,
  fixturePath,
  openFeaturesPopover,
  sendMessage,
  setReasoningEffort,
  setSwitch,
  waitForIdleComposer,
  waitForRunDone,
  REAL_LLM_MODEL,
  REAL_LLM_REASONING_EFFORT,
} from "./helpers";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(E2E_DIR, "../../.playwright-mcp/user-skills-mcp");

const TEST_EMAIL = "shafiq@testing.com";
const TEST_PASSWORD = "Test@123";
const TEST_NAME = "Shafiq Testing";

const SKILL_NAME = "e2e-marker";
const UPLOADED_SKILL_NAME = "e2e-uploaded";
const MCP_NAME = "e2e-docs";

function sessionCookie(headers: Record<string, string>): string | null {
  const raw = headers["set-cookie"] ?? "";
  for (const pair of raw.split(/,(?=[^ ;]+=)/)) {
    const equals = pair.indexOf("=");
    if (equals < 0) continue;
    if (pair.slice(0, equals).trim() === "better-auth.session_token") {
      return pair.slice(equals + 1).split(";")[0]!.trim();
    }
  }
  return null;
}

async function ensureTestUser(page: Page): Promise<void> {
  const origin = "http://localhost:3000";
  const signIn = await page.request.post(`${API_ORIGIN}/api/auth/sign-in/email`, {
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
    headers: { origin },
  });
  let cookie = sessionCookie(signIn.headers());
  if (!cookie) {
    const signUp = await page.request.post(`${API_ORIGIN}/api/auth/sign-up/email`, {
      data: { name: TEST_NAME, email: TEST_EMAIL, password: TEST_PASSWORD },
      headers: { origin },
    });
    expect(signUp.ok()).toBe(true);
    cookie = sessionCookie(signUp.headers());
  }
  expect(cookie).toBeTruthy();
  await page.context().addCookies([
    {
      name: "better-auth.session_token",
      value: cookie!,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

async function apiDeleteByPrefix(
  page: Page,
  path: "skills" | "mcp-servers",
  prefix: string,
): Promise<void> {
  const list = await page.request.get(`${API_ORIGIN}/api/${path}`);
  expect(list.ok()).toBe(true);
  const rows = (await list.json()) as { id: string; name: string }[];
  for (const row of rows) {
    if (row.name.startsWith(prefix)) {
      await page.request.delete(`${API_ORIGIN}/api/${path}/${encodeURIComponent(row.id)}`);
    }
  }
}

async function saveEvidence(page: Page, caseId: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, `${caseId}.png`),
    scale: "css",
    mask: [page.locator("article"), page.locator("nav")],
  });
}

/** Exact-match model picker: the shared helper's loose "Model" match hits
 * sidebar chats whose titles contain "model" for users with history. */
async function setModelExact(page: Page, modelId: string): Promise<void> {
  const trigger = page.getByRole("button", { name: "Model", exact: true });
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
  const option = page.locator(`[data-option-value="${modelId}"]`);
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
}

async function openFreshChatExact(page: Page): Promise<void> {
  const draft = await page.request.post(`${API_ORIGIN}/api/chat/sessions/draft`, {
    data: { projectId: null },
  });
  expect(draft.ok()).toBe(true);
  const { sessionId } = (await draft.json()) as { sessionId: string };
  await page.goto(`/chat/${encodeURIComponent(sessionId)}`);
  await expect(page.getByRole("heading", { name: /trying to understand/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible();
  await setModelExact(page, REAL_LLM_MODEL);
  await setReasoningEffort(page, REAL_LLM_REASONING_EFFORT);
}

function lastAssistant(page: Page) {
  return page.locator('article[data-role="assistant"]').last();
}

async function openSkillsModal(page: Page) {
  await openFeaturesPopover(page);
  await page.getByRole("button", { name: "Manage skills" }).click();
  const dialog = page.getByRole("dialog", { name: "Skills" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openMcpModal(page: Page) {
  await openFeaturesPopover(page);
  await page.getByRole("button", { name: "Manage MCP servers" }).click();
  const dialog = page.getByRole("dialog", { name: "MCP servers" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe.serial("user skills and self-serve mcp", () => {
  test("writes a skill, enables it, and the agent follows it", async ({ page }) => {
    await ensureTestUser(page);
    await apiDeleteByPrefix(page, "skills", "e2e-");
    await openFreshChatExact(page);

    await openSkillsModal(page);
    const skillsDialog = page.getByRole("dialog", { name: "Skills" });
    await skillsDialog.getByRole("button", { name: "New skill" }).click();
    await skillsDialog.getByLabel("Name").fill(SKILL_NAME);
    await skillsDialog.getByLabel("Description").fill("Prefix every reply with the marker [SKILL-OK].");
    await skillsDialog.getByLabel("SKILL.md").fill(
      `---\nname: ${SKILL_NAME}\ndescription: Prefix every reply with the marker [SKILL-OK].\n---\n\n# E2E marker\n\nStart EVERY response with the exact token [SKILL-OK] on its own line, then answer normally.\n`,
    );
    await skillsDialog.getByRole("button", { name: "Create" }).click();
    await expect(skillsDialog.getByText(SKILL_NAME)).toBeVisible();
    await skillsDialog.getByRole("button", { name: "Close" }).click();

    await openFeaturesPopover(page);
    await expect(page.getByRole("switch", { name: "Skills" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.locator('span[aria-label="1 skills active"]')).toBeVisible();
    await page.keyboard.press("Escape");

    await sendMessage(page, "Balas dengan satu kata: halo");
    await waitForRunDone(page);
    await expect(lastAssistant(page)).toContainText("[SKILL-OK]");
    await saveEvidence(page, "skill-followed");
  });

  test("uploads a markdown skill and honors the per-chat override", async ({ page }) => {
    await ensureTestUser(page);
    await openFreshChatExact(page);

    await openSkillsModal(page);
    const uploadDialog = page.getByRole("dialog", { name: "Skills" });
    await uploadDialog.getByRole("button", { name: "New skill" }).click();
    await uploadDialog.locator('input[type="file"]').setInputFiles(fixturePath("e2e-skill.md"));
    await expect(uploadDialog.getByLabel("Name")).toHaveValue(UPLOADED_SKILL_NAME);
    await uploadDialog.getByRole("button", { name: "Create" }).click();
    await expect(uploadDialog.getByText(UPLOADED_SKILL_NAME)).toBeVisible();
    await uploadDialog.getByRole("button", { name: "Close" }).click();

    await setSwitch(page, "Skills", false);
    await sendMessage(page, "Balas dengan satu kata: halo");
    await waitForRunDone(page);
    await expect(lastAssistant(page)).not.toContainText("[SKILL-OK]");

    await setSwitch(page, "Skills", true);
    await sendMessage(page, "Balas dengan satu kata: halo");
    await waitForRunDone(page);
    await expect(lastAssistant(page)).toContainText("[SKILL-OK]");
    await saveEvidence(page, "skill-override");
  });

  test("connects an MCP server, tests it, and the agent uses its tools", async ({ page }) => {
    await ensureTestUser(page);
    await apiDeleteByPrefix(page, "mcp-servers", "e2e-");
    await openFreshChatExact(page);

    await openMcpModal(page);
    const mcpDialog = page.getByRole("dialog", { name: "MCP servers" });
    await mcpDialog.getByRole("button", { name: "New server" }).click();
    await mcpDialog.getByLabel("Name").fill(MCP_NAME);
    await mcpDialog.getByLabel("Server URL").fill("https://mcp.context7.com/mcp");
    await mcpDialog.getByRole("button", { name: "Test connection" }).click();
    await expect(mcpDialog.getByRole("checkbox", { name: /resolve-library-id/ })).toBeVisible({
      timeout: 120_000,
    });
    await mcpDialog.getByRole("button", { name: "Add server" }).click();
    await expect(mcpDialog.getByText(MCP_NAME)).toBeVisible();
    await mcpDialog.getByRole("button", { name: "Close" }).click();

    await setSwitch(page, "MCP", true);
    await setSwitch(page, "Web search", false);
    await sendMessage(
      page,
      "Use the docs tools to tell me which library id you would use for Next.js",
    );
    await waitForRunDone(page);
    await expandAssistantToolPanels(page);
    const tools = page.locator('article[data-role="assistant"]');
    const lastText = (await tools.last().textContent()) ?? "";
    console.log(`LAST_ASSISTANT=${lastText.replace(/\s+/g, " ").slice(0, 800)}`);
    // The docs tools identify themselves by result shape ("Selected Library
    // ID", benchmark/reputation lines) rather than by tool name in prose.
    // Web search is off for this run, so only the MCP tools can answer.
    await expect(tools.last()).toContainText(/selected library id|library id/i);
    await saveEvidence(page, "mcp-used");

    await setSwitch(page, "MCP", false);
    await openFeaturesPopover(page);
    await expect(page.locator('span[aria-label="0 MCP servers active"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
  });

  test("remembers the last on/off state across reload", async ({ page }) => {
    await ensureTestUser(page);
    await openFreshChatExact(page);

    await setSwitch(page, "Skills", true);
    await setSwitch(page, "MCP", false);
    await page.reload();
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({ timeout: 30_000 });
    await openFeaturesPopover(page);
    await expect(page.getByRole("switch", { name: "Skills" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(page.getByRole("switch", { name: "MCP" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    await page.keyboard.press("Escape");
    await waitForIdleComposer(page);
    await saveEvidence(page, "state-remembered");
  });
});

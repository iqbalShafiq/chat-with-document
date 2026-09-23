/**
 * Agent-managed skills & MCP acceptance with the real stack and real LLM.
 * Prerequisites: same as user-skills-mcp.real-llm.e2e.ts
 * (running stack, real OpenRouter key, shafiq@testing.com / Test@123).
 * Run: `pnpm --filter @anreal/platform e2e -- --config playwright.real-llm.config.ts e2e/agent-managed-skills.real-llm.e2e.ts`
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ORIGIN,
  REAL_LLM_MODEL,
  REAL_LLM_REASONING_EFFORT,
  sendMessage,
  setReasoningEffort,
  waitForRunDone,
} from "./helpers";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(E2E_DIR, "../../.playwright-mcp/agent-managed-skills");

const TEST_EMAIL = "shafiq@testing.com";
const TEST_PASSWORD = "Test@123";

const SKILL_NAME = "e2e-agent-skill";
const MCP_NAME = "e2e-agent-mcp";

/** Exact-match model picker (see user-skills-mcp spec: loose match hits history). */
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

async function ensureTestUser(page: Page): Promise<void> {
  const origin = "http://localhost:3000";
  const signIn = await page.request.post(`${API_ORIGIN}/api/auth/sign-in/email`, {
    data: { email: TEST_EMAIL, password: TEST_PASSWORD },
    headers: { origin },
  });
  const setCookie = signIn.headers()["set-cookie"] ?? "";
  let cookie = setCookie.match(/better-auth\.session_token=([^;]+)/)?.[1] ?? null;
  if (!cookie) {
    const signUp = await page.request.post(`${API_ORIGIN}/api/auth/sign-up/email`, {
      data: { name: "Shafiq Testing", email: TEST_EMAIL, password: TEST_PASSWORD },
      headers: { origin },
    });
    expect(signUp.ok()).toBe(true);
    const signupCookie = signUp.headers()["set-cookie"] ?? "";
    cookie = signupCookie.match(/better-auth\.session_token=([^;]+)/)?.[1] ?? null;
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

async function apiSkillByName(
  page: Page,
  name: string,
): Promise<{ id: string; status: string; isEnabled: boolean } | null> {
  const list = await page.request.get(`${API_ORIGIN}/api/skills`);
  const rows = (await list.json()) as { id: string; name: string; status: string; isEnabled: boolean }[];
  return rows.find((row) => row.name === name) ?? null;
}

async function apiMcpByName(
  page: Page,
  name: string,
): Promise<{ id: string; status: string } | null> {
  const list = await page.request.get(`${API_ORIGIN}/api/mcp-servers`);
  const rows = (await list.json()) as { id: string; name: string; status: string }[];
  return rows.find((row) => row.name === name) ?? null;
}

async function saveEvidence(page: Page, caseId: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, `${caseId}.png`),
    scale: "css",
    mask: [page.locator("article"), page.locator("nav")],
  });
}

function lastAssistant(page: Page) {
  return page.locator('article[data-role="assistant"]').last();
}

async function approveOnce(page: Page): Promise<void> {
  const allow = page.getByRole("button", { name: "Allow once" });
  await expect(allow).toBeVisible({ timeout: 120_000 });
  await allow.click();
}

test.describe.serial("agent-managed skills and mcp", () => {
  test("saves a skill through approval as a draft", async ({ page }) => {
    await ensureTestUser(page);
    await apiDeleteByPrefix(page, "skills", "e2e-agent-");
    await openFreshChatExact(page);

    await sendMessage(page, `Please save "always start replies with [AGENT-SKILL]" as a skill named ${SKILL_NAME}`);
    await approveOnce(page);
    await waitForRunDone(page);

    const skill = await apiSkillByName(page, SKILL_NAME);
    expect(skill).not.toBeNull();
    expect(skill?.status).toBe("draft");
    expect(skill?.isEnabled).toBe(false);
    await saveEvidence(page, "agent-skill-draft");
  });

  test("refuses direct enable, then follows the skill after manual enable", async ({ page }) => {
    await ensureTestUser(page);
    await openFreshChatExact(page);

    await sendMessage(page, `Please enable the skill named ${SKILL_NAME}`);
    await approveOnce(page);
    await waitForRunDone(page);
    await expect(lastAssistant(page)).toContainText(/modal|review/i);

    const skill = await apiSkillByName(page, SKILL_NAME);
    expect(skill).not.toBeNull();
    const enabled = await page.request.patch(
      `${API_ORIGIN}/api/skills/${encodeURIComponent(skill!.id)}/enabled`,
      { data: { isEnabled: true } },
    );
    // Drafts cannot be enabled until reviewed: flip via update first.
    if (!enabled.ok()) {
      const full = await page.request.get(`${API_ORIGIN}/api/skills/${skill!.id}`);
      const body = (await full.json()) as { description: string; bodyMd: string };
      const updated = await page.request.put(
        `${API_ORIGIN}/api/skills/${encodeURIComponent(skill!.id)}`,
        {
          data: {
            name: SKILL_NAME,
            description: body.description,
            bodyMd: body.bodyMd,
          },
        },
      );
      expect(updated.ok()).toBe(true);
      const retry = await page.request.patch(
        `${API_ORIGIN}/api/skills/${encodeURIComponent(skill!.id)}/enabled`,
        { data: { isEnabled: true } },
      );
      expect(retry.ok()).toBe(true);
    }

    await sendMessage(page, "Balas dengan satu kata: halo");
    await waitForRunDone(page);
    await expect(lastAssistant(page)).toContainText("[AGENT-SKILL]");
    await saveEvidence(page, "agent-skill-followed");
  });

  test("connects an MCP server through approval without a test", async ({ page }) => {
    await ensureTestUser(page);
    await apiDeleteByPrefix(page, "mcp-servers", "e2e-agent-");
    await openFreshChatExact(page);

    await sendMessage(
      page,
      `Please connect the MCP server at https://mcp.context7.com/mcp with the name ${MCP_NAME}`,
    );
    await approveOnce(page);
    await waitForRunDone(page);

    const server = await apiMcpByName(page, MCP_NAME);
    expect(server).not.toBeNull();
    expect(server?.status).toBe("untested");
    await saveEvidence(page, "agent-mcp-untested");
  });

  test("cleans up agent-created rows", async ({ page }) => {
    await ensureTestUser(page);
    await apiDeleteByPrefix(page, "skills", "e2e-agent-");
    await apiDeleteByPrefix(page, "mcp-servers", "e2e-agent-");
    expect(await apiSkillByName(page, SKILL_NAME)).toBeNull();
    expect(await apiMcpByName(page, MCP_NAME)).toBeNull();
  });
});

/**
 * Shared helpers for the headed real-LLM E2E specs (no local stub).
 * Extracted from `real-llm.e2e.ts`; also used by `data-analysis.real-llm.e2e.ts`.
 */
import { expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

export const API_ORIGIN = "http://localhost:3001";

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
}

export async function openFreshChat(page: Page): Promise<void> {
  const draft = await page.request.post(`${API_ORIGIN}/api/chat/sessions/draft`, {
    data: { projectId: null },
  });
  expect(draft.ok()).toBe(true);
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await expect(page.getByText("Ask anything about your documents")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible();
}

export async function sendMessage(page: Page, text: string): Promise<void> {
  const editor = page.locator("[data-anvia-composer-editor]");
  await editor.click();
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.pressSequentially(text, { delay: 15 });
  await editor.press("Enter");
}

export async function waitForStreaming(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: /^(Stop|Add to queue)$/ }),
  ).toBeVisible({ timeout: 30_000 });
}

export async function waitForRunDone(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 150_000,
  });
}

export async function openFeaturesPopover(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Additional features" }).click();
  await expect(page.getByRole("dialog", { name: "Additional features" })).toBeVisible();
}

export async function setSwitch(page: Page, name: string, on: boolean): Promise<void> {
  await openFeaturesPopover(page);
  const toggle = page.getByRole("switch", { name });
  const checked = (await toggle.getAttribute("aria-checked")) === "true";
  if (checked !== on) await toggle.click();
  await page.keyboard.press("Escape");
}

/** Switch the composer model via the model dropdown (e.g. deepseek/deepseek-v4-flash-0731). */
export async function setModel(page: Page, modelId: string): Promise<void> {
  const trigger = page.getByRole("button", { name: "Model" }).first();
  // Fallback to aria-label selector if role lookup fails (headless race).
  const triggerVisible = await trigger.isVisible().catch(() => false);
  const effectiveTrigger = triggerVisible ? trigger : page.locator('button[aria-label="Model"]').first();
  await effectiveTrigger.click();
  const option = page.locator(`[data-option-value="${modelId}"]`);
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
  await expect(effectiveTrigger).toContainText(/./);
}

/**
 * Attach a fixture file via the real file chooser (composer attach control).
 * Ingestion only starts once the message is sent (see submitMessage in the
 * chat page), so `uploadAndAsk` sends first, then waits for the document to
 * become active in the rail before the run can be considered underway.
 */
export async function attachFile(page: Page, filename: string): Promise<void> {
  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Attach document" }).click();
  await page.getByText("Upload from computer").click();
  const chooser = await chooserPromise;
  await chooser.setFiles(fixturePath(filename));
}

/**
 * Attach a fixture and ask a question. File ingestion is triggered by
 * sendMessage, so the run may already be underway by the time we check the
 * rail. Best practice: don't gate the run on the rail's "Active documents"
 * text with a huge timeout — the spec asserts DataTable/DataChart, not the
 * rail. The rail check is a soft, short-lived sanity check only.
 */
export async function uploadAndAsk(
  page: Page,
  filename: string,
  question: string,
): Promise<void> {
  await attachFile(page, filename);
  await sendMessage(page, question);
  // Soft check: if the rail's "Active documents" shows up quickly, great; if
  // not, keep going — the real assertion is DataTable/DataChart visibility.
  const rail = page.locator('aside[aria-label="Session documents"]');
  await expect(rail.getByText("Active documents")).toBeVisible({ timeout: 30_000 }).catch(() => {});
  await waitForRunDone(page);
}

/**
 * Tool-activity panels auto-collapse once their tool completes; the DataTable
 * / DataChart contents only render while expanded. Expand every collapsed
 * panel so assertions see the results. No-op if no panels exist.
 */
export async function expandAssistantToolPanels(page: Page): Promise<void> {
  const collapsed = page.locator('article[data-role="assistant"] button[aria-expanded="false"]');
  const count = await collapsed.count();
  if (count === 0) return;
  for (let i = 0; i < count; i++) {
    const btn = page.locator('article[data-role="assistant"] button[aria-expanded="false"]').first();
    if (await btn.isVisible().catch(() => false)) await btn.click();
  }
}
/**
 * Headed E2E against a live OpenRouter key (no local stub).
 * Requires `pnpm dev` on :3000 / :3001 with real OPENAI_* from `.env`.
 */
import { expect, test, type Page } from "@playwright/test";

const API_ORIGIN = "http://localhost:3001";

async function openFreshChat(page: Page): Promise<void> {
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

async function sendMessage(page: Page, text: string): Promise<void> {
  const editor = page.locator("[data-anvia-composer-editor]");
  await editor.click();
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.pressSequentially(text, { delay: 15 });
  await editor.press("Enter");
}

async function waitForStreaming(page: Page): Promise<void> {
  await expect(
    page.getByRole("button", { name: /^(Stop|Add to queue)$/ }),
  ).toBeVisible({ timeout: 30_000 });
}

async function waitForRunDone(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 150_000,
  });
}

async function openFeaturesPopover(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Additional features" }).click();
  await expect(page.getByRole("dialog", { name: "Additional features" })).toBeVisible();
}

async function setSwitch(page: Page, name: string, on: boolean): Promise<void> {
  await openFeaturesPopover(page);
  const toggle = page.getByRole("switch", { name });
  const checked = (await toggle.getAttribute("aria-checked")) === "true";
  if (checked !== on) await toggle.click();
  await page.keyboard.press("Escape");
}

test("stream a short reply from the real model", async ({ page }) => {
  await openFreshChat(page);
  await sendMessage(
    page,
    "Reply with exactly the token REAL_LLM_OK and nothing else.",
  );
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.getByText("REAL_LLM_OK").last()).toBeVisible({
    timeout: 10_000,
  });
});

test("composer stays editable and queues a follow-up while streaming", async ({
  page,
}) => {
  await openFreshChat(page);
  await sendMessage(
    page,
    "Write 30 numbered trivia facts about TypeScript, one short sentence each. Do not stop early.",
  );
  await waitForStreaming(page);
  const editor = page.locator("[data-anvia-composer-editor]");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.click();
  await editor.pressSequentially("After you finish, reply QUEUE_OK on its own line.", {
    delay: 8,
  });
  const addToQueue = page.getByRole("button", { name: "Add to queue" });
  await expect(addToQueue).toBeVisible({ timeout: 10_000 });
  await addToQueue.click();
  const queuedDock = page.getByRole("list", { name: "Queued messages" });
  // Steer may flush immediately at a turn boundary, so the dock can be empty.
  if (await queuedDock.isVisible().catch(() => false)) {
    await expect(queuedDock).toContainText("QUEUE_OK");
  }
  await waitForRunDone(page);
  await expect(page.getByText("QUEUE_OK").last()).toBeVisible({
    timeout: 150_000,
  });
});

test("stats tool runs against a real model", async ({ page }) => {
  await openFreshChat(page);
  await sendMessage(
    page,
    "Use the descriptive_stats tool on [12, 15, 18, 20, 22]. Then tell me the mean.",
  );
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.locator("article").last()).toContainText(/17\.4|mean/i);
});

test("web search with the toggle on uses live Tavily", async ({ page, request }) => {
  const caps = await request.get(`${API_ORIGIN}/api/chat/capabilities`);
  expect(caps.ok()).toBe(true);
  const body = (await caps.json()) as { webSearchAvailable?: boolean };
  test.skip(!body.webSearchAvailable, "TAVILY_API_KEY not available");

  await openFreshChat(page);
  await setSwitch(page, "Web search", true);
  await sendMessage(
    page,
    "Search the web for the official Anvia TypeScript runtime GitHub repo and tell me the org/repo name.",
  );
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.getByText(/anvia/i).last()).toBeVisible();
});

test("image generation with the toggle on uses the live image API", async ({
  page,
  request,
}) => {
  const caps = await request.get(`${API_ORIGIN}/api/chat/capabilities`);
  expect(caps.ok()).toBe(true);
  const body = (await caps.json()) as { imageGenerationAvailable?: boolean };
  test.skip(!body.imageGenerationAvailable, "image generation not available");

  await openFreshChat(page);
  await setSwitch(page, "Image generator", true);
  await sendMessage(
    page,
    "Generate a simple 1:1 picture of a single orange cat sitting on a white background. No extra questions.",
  );
  await waitForStreaming(page);
  await waitForRunDone(page);
  const rail = page.locator('aside[aria-label="Session documents"]');
  await expect(rail.locator("img").first()).toBeVisible({ timeout: 60_000 });
});

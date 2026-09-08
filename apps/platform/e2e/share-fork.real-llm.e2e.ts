/**
 * Real-LLM fork E2E (Muse Spark, minimal effort, no stub):
 * seed chat with one real exchange -> share -> signed-in fork -> snapshot frozen.
 *
 * Requires the real OpenRouter stack (`pnpm dev` + real OPENAI_* in `.env`):
 * OPENAI_BASE_URL must be https://openrouter.ai/api/v1 (asserted in the
 * shared real-llm global setup). Run with:
 *   pnpm exec -- playwright test --config playwright.share-fork.real-llm.config.ts --headed
 */
import { expect, test, type Page } from "@playwright/test";

const API_ORIGIN =
  process.env.E2E_API_ORIGIN?.replace(/\/+$/, "") || "http://localhost:4312";
const FORK_MODEL = "meta/muse-spark-1.3-contributor";
const FORK_EFFORT = "minimal";

/** Select Muse Spark + minimal effort through the composer switcher. */
async function selectForkModel(page: Page): Promise<void> {
  const modelTrigger = page.getByRole("button", { name: "Model" }).first();
  await expect(modelTrigger).toBeVisible({ timeout: 30_000 });
  await modelTrigger.click();
  const modelOption = page.locator(
    `[data-option-value="${FORK_MODEL}"]`,
  );
  await expect(modelOption).toBeVisible({ timeout: 30_000 });
  await modelOption.click();
  await expect(modelTrigger).toContainText(/muse spark/i, {
    timeout: 30_000,
  });

  const effortTrigger = page
    .getByRole("button", { name: "Reasoning effort" })
    .first();
  await expect(effortTrigger).toBeVisible({ timeout: 30_000 });
  await effortTrigger.click();
  const effortOption = page.locator(
    `[data-option-value="${FORK_EFFORT}"]`,
  );
  await expect(effortOption).toBeVisible({ timeout: 30_000 });
  await effortOption.click();
  await expect(effortTrigger).toContainText(/minimal/i, {
    timeout: 30_000,
  });
}

async function seedChatWithRealLlm(
  page: Page,
  title: string,
  seed: string,
): Promise<string> {
  const draft = await page.request.post(
    `${API_ORIGIN}/api/chat/sessions/draft`,
    { data: { projectId: null } },
  );
  expect(draft.ok()).toBe(true);
  const { sessionId } = (await draft.json()) as { sessionId: string };
  const renamed = await page.request.patch(
    `${API_ORIGIN}/api/chat/sessions/${sessionId}`,
    { data: { title } },
  );
  expect(renamed.ok()).toBe(true);
  await page.goto(`/chat/${sessionId}`);
  const editor = page.locator("[data-anvia-composer-editor]");
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await selectForkModel(page);
  await editor.click();
  await editor.pressSequentially(seed, { delay: 5 });
  const send = page.getByRole("button", { name: "Send", exact: true });
  const stop = page.getByRole("button", { name: "Stop" });
  if (await send.isVisible().catch(() => false)) {
    await send.click();
  } else {
    await editor.press("Enter");
  }
  await stop
    .waitFor({ state: "visible", timeout: 30_000 })
    .catch(() => undefined);
  await expect(send).toBeVisible({ timeout: 300_000 });
  return sessionId;
}

test("real-LLM fork: muse-spark minimal seeds, shares, and forks", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const stamp = Date.now();
  const sessionId = await seedChatWithRealLlm(
    page,
    `fork-real-${stamp}`,
    `Reply with exactly the token FORK_SEED_OK_${stamp} and nothing else.`,
  );

  // The real model answered inside the source chat (proves real LLM, not stub).
  await expect(page.getByText(`FORK_SEED_OK_${stamp}`).first()).toBeVisible({
    timeout: 60_000,
  });

  const created = await page.request.post(
    `${API_ORIGIN}/api/chat/sessions/${sessionId}/shares`,
  );
  expect(created.ok()).toBe(true);
  const { urlPath } = (await created.json()) as { urlPath: string };

  await page.goto(urlPath);
  const followUp = page.getByPlaceholder(/follow-up/i);
  await expect(followUp).toBeVisible({ timeout: 30_000 });
  await followUp.click();
  await followUp.pressSequentially(
    `Reply with exactly the token FORK_COPY_OK_${stamp} and nothing else.`,
    { delay: 5 },
  );
  await page.getByRole("button", { name: /send as my copy/i }).click();
  await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+/, {
    timeout: 60_000,
  });
  const forkUrl = new URL(page.url());
  expect(forkUrl.pathname).not.toContain(sessionId);

  // The fork seeds the follow-up as the first user message and the worker
  // answers it with the live transport: wait for the run to settle, then
  // assert the real model echoed the token (proves real LLM, not stub).
  // NOTE: the fork page's composer is intentionally empty — the follow-up
  // was already sent from the share page — so never click Send here.
  const forkEditor = page.locator("[data-anvia-composer-editor]");
  await expect(forkEditor).toBeVisible({ timeout: 60_000 });
  const forkSend = page.getByRole("button", { name: "Send", exact: true });
  const forkStop = page.getByRole("button", { name: "Stop" });
  await forkStop
    .waitFor({ state: "visible", timeout: 60_000 })
    .catch(() => undefined);
  await expect(forkSend).toBeVisible({ timeout: 300_000 });
  await expect(page.getByText(`FORK_COPY_OK_${stamp}`).first()).toBeVisible({
    timeout: 60_000,
  });

  // The shared snapshot stays frozen: the fork's first message never appears.
  await page.goto(urlPath);
  await expect(
    page.getByRole("heading", { name: `fork-real-${stamp}` }),
  ).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByText(`FORK_COPY_OK_${stamp}`),
  ).toHaveCount(0);
});

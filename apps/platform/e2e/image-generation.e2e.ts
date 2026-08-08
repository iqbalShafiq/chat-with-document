/**
 * Browser E2E for image generation against a local LLM/image stub.
 *
 * Node requirement: the stub runs via native type stripping (`node
 * e2e/stub-openrouter.ts`), so Node >= 22.18 (or 23.6+) is required.
 *
 * Test "web search tool call precedes the image generation" drives a REAL
 * web_search tool execution: TAVILY_API_KEY=dummy makes the worker call the
 * real Tavily API, which returns 401 (bounded error) — the run must continue
 * and still generate the image. The assertion checks tool-call ORDERING in
 * the stub's recorded requests, never search success.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const STUB_ORIGIN = "http://127.0.0.1:18765";
const API_ORIGIN = "http://localhost:3001";

const rail = (page: Page) => page.locator('aside[aria-label="Session documents"]');
const approvalRegion = (page: Page) =>
  page.getByRole("region", { name: "Approve generating image" });

async function openFreshChat(page: Page): Promise<void> {
  const draftResponse = await page.request.post(`${API_ORIGIN}/api/chat/sessions/draft`, {
    data: { projectId: null },
  });
  expect(draftResponse.ok()).toBe(true);
  await page.goto("/");
  await expect(
    page.getByText("Ask anything about your documents"),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible();
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const editor = page.locator("[data-anvia-composer-editor]");
  await editor.click();
  await editor.pressSequentially(text);
  await editor.press("Enter");
}

async function waitForRailImage(page: Page, prompt: string): Promise<void> {
  await expect(rail(page).getByAltText(prompt, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
}

async function waitForRunDone(page: Page): Promise<void> {
  await expect(page.getByText(/Selesai:/).last()).toBeVisible({
    timeout: 30_000,
  });
}

async function openFeaturesPopover(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Additional features" }).click();
  await expect(page.getByRole("dialog", { name: "Additional features" })).toBeVisible();
}

async function enableImageGeneration(page: Page): Promise<void> {
  await openFeaturesPopover(page);
  const toggle = page.getByRole("switch", { name: "Image generator" });
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await toggle.click();
  }
  await page.keyboard.press("Escape");
}

async function enableWebSearch(page: Page): Promise<void> {
  await openFeaturesPopover(page);
  const toggle = page.getByRole("switch", { name: "Web search" });
  if ((await toggle.getAttribute("aria-checked")) !== "true") {
    await toggle.click();
  }
  await page.keyboard.press("Escape");
}

async function resetStub(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${STUB_ORIGIN}/__reset`);
  expect(response.ok()).toBe(true);
}

async function stubRequests(request: APIRequestContext): Promise<unknown[]> {
  const response = await request.get(`${STUB_ORIGIN}/__requests`);
  const data = (await response.json()) as { requests: unknown[] };
  return data.requests;
}

function imagesRequests(requests: unknown[]): Record<string, unknown>[] {
  return requests.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry &&
      typeof entry === "object" &&
      (entry as { kind?: unknown }).kind === "images",
  );
}

function toolCallOrder(requests: unknown[]): string[] {
  const order: string[] = [];
  for (const entry of requests) {
    if (!entry || typeof entry !== "object") continue;
    if ((entry as { kind?: unknown }).kind !== "responses") continue;
    const body = (entry as { body?: unknown }).body;
    if (!body || typeof body !== "object") continue;
    const input = (body as { input?: unknown }).input;
    if (!Array.isArray(input)) continue;
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (record.type !== "function_call") continue;
      if (typeof record.name === "string") order.push(record.name);
    }
  }
  return order;
}

test.beforeEach(async ({ request }) => {
  await resetStub(request);
});

test("popover shows feature toggles and image settings", async ({ page }) => {
  await openFreshChat(page);
  await openFeaturesPopover(page);

  await expect(page.getByText("Web search")).toBeVisible();
  await expect(page.getByText("Image generator")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Web search" })).toBeVisible();
  await expect(page.getByRole("switch", { name: "Image generator" })).toBeVisible();

  await page.getByRole("switch", { name: "Image generator" }).click();

  await expect(page.getByText("Model")).toBeVisible();
  await expect(page.getByRole("button", { name: /Image model, GPT-5 Image Mini/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "16:9" })).toBeVisible();
  const transparent = page.getByRole("checkbox", { name: "Transparent background" });
  await expect(transparent).toBeVisible();
  await expect(transparent).not.toBeChecked();
  await transparent.click();
  await expect(transparent).toBeChecked();
});

test("approval card appears for a generation while the toggle is off, allow once works", async ({
  page,
}) => {
  await openFreshChat(page);
  await sendMessage(page, "buatkan gambar kucing di taman");

  const card = approvalRegion(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText("Needs approval")).toBeVisible();
  await expect(card.getByRole("button", { name: "Reject" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Allow once" })).toBeVisible();
  await expect(card.getByRole("button", { name: "Allow for session" })).toBeVisible();

  await card.getByRole("button", { name: "Allow once" }).click();

  await expect(rail(page).locator(".skeleton-shimmer").first()).toBeVisible({
    timeout: 20_000,
  });
  await waitForRailImage(page, "buatkan gambar kucing di taman");
  await waitForRunDone(page);

  // "Allow once" is per-call: the next generation in the same session must
  // ask for approval again.
  await sendMessage(page, "buatkan gambar kucing sekali lagi");
  await expect(approvalRegion(page)).toBeVisible({ timeout: 30_000 });
  await approvalRegion(page)
    .getByRole("button", { name: "Allow once" })
    .click();
  await waitForRailImage(page, "buatkan gambar kucing sekali lagi");
  await waitForRunDone(page);
});

test("rejecting an image approval skips generation", async ({ page, request }) => {
  await openFreshChat(page);
  await sendMessage(page, "buatkan gambar kucing yang ditolak");

  const card = approvalRegion(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Reject" }).click();
  await card.getByRole("button", { name: "Reject" }).click();

  await waitForRunDone(page);
  await expect(rail(page).getByText("Generated images")).toHaveCount(0);
  expect(imagesRequests(await stubRequests(request))).toHaveLength(0);
});

test("session grant persists across messages", async ({ page }) => {
  await openFreshChat(page);
  await sendMessage(page, "buatkan gambar kucing");

  const card = approvalRegion(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "Allow for session" }).click();
  await waitForRailImage(page, "buatkan gambar kucing");
  await waitForRunDone(page);

  await sendMessage(page, "buatkan gambar kucing lagi");
  await waitForRailImage(page, "buatkan gambar kucing lagi");
  await waitForRunDone(page);
  await expect(approvalRegion(page)).toHaveCount(0);
});

test("aspect ratio edited on the approval card is applied to the image request", async ({
  page,
  request,
}) => {
  await openFreshChat(page);
  await sendMessage(page, "buatkan gambar kucing");

  const card = approvalRegion(page);
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByRole("button", { name: "16:9" }).click();
  await card.getByRole("button", { name: "Allow once" }).click();

  await waitForRailImage(page, "buatkan gambar kucing");
  await waitForRunDone(page);

  const imageBodies = imagesRequests(await stubRequests(request));
  expect(imageBodies.length).toBeGreaterThan(0);
  const lastImage = imageBodies.at(-1) as Record<string, unknown>;
  expect((lastImage.body as Record<string, unknown>).size).toBe("1344x768");
});

test("clarification wizard collects answers then generates the image", async ({
  page,
}) => {
  await openFreshChat(page);
  await enableImageGeneration(page);
  await sendMessage(page, "buatkan gambar yang kurang jelas");

  const wizard = page.getByRole("region", { name: "Clarification" });
  await expect(wizard).toBeVisible({ timeout: 30_000 });
  await expect(wizard.getByText("Pertanyaan 1 dari 2")).toBeVisible();
  await expect(wizard.getByText("Recommended")).toBeVisible();

  await wizard.getByRole("radio", { name: /A minimalis/ }).click();
  await wizard.getByRole("button", { name: "Next" }).click();

  await expect(wizard.getByText("Pertanyaan 2 dari 2")).toBeVisible();
  const skip = wizard.getByRole("button", { name: "Skip" });
  await expect(skip).toBeVisible();
  await skip.click();

  await wizard.getByRole("button", { name: "Submit" }).click();

  await waitForRailImage(page, "buatkan gambar yang kurang jelas");
  await waitForRunDone(page);
});

test("web search tool call precedes the image generation", async ({ page, request }) => {
  await openFreshChat(page);
  await enableWebSearch(page);
  await enableImageGeneration(page);
  await sendMessage(page, "cari referensi lalu buatkan gambar kucing");

  await waitForRailImage(page, "cari referensi lalu buatkan gambar kucing");
  await waitForRunDone(page);

  const order = toolCallOrder(await stubRequests(request));
  const webSearchIndex = order.indexOf("web_search");
  const generateImageIndex = order.indexOf("generate_image");
  expect(webSearchIndex).toBeGreaterThanOrEqual(0);
  expect(generateImageIndex).toBeGreaterThan(webSearchIndex);
});

test("background removed sends transparent png params and the gallery lists the image", async ({
  page,
  request,
}) => {
  await openFreshChat(page);
  await enableImageGeneration(page);
  await sendMessage(page, "buatkan gambar kucing dengan background removed");

  await waitForRailImage(page, "buatkan gambar kucing dengan background removed");
  await waitForRunDone(page);

  const imageBodies = imagesRequests(await stubRequests(request));
  expect(imageBodies.length).toBeGreaterThan(0);
  const lastImage = imageBodies.at(-1) as Record<string, unknown>;
  const body = lastImage.body as Record<string, unknown>;
  expect(body.background).toBe("transparent");
  expect(body.output_format).toBe("png");

  await page.getByRole("button", { name: /^Images/ }).click();
  const gallery = page.getByRole("dialog", { name: "Images" });
  await expect(gallery).toBeVisible();
  await expect(
    gallery.getByRole("button", { name: /Filter images by project, Semua/ }),
  ).toBeVisible();
  await expect(
    gallery.getByAltText("buatkan gambar kucing dengan background removed", {
      exact: true,
    }),
  ).toBeVisible({ timeout: 30_000 });
});

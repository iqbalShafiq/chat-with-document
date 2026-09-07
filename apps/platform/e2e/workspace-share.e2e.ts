/**
 * Public share-link E2E (stub LLM, no real key):
 * generate → anonymous read → login fork → deactivate → delete cascade.
 *
 * Share semantics under test (frozen snapshot, one-shot token display,
 * all-or-nothing deactivate, independent forks):
 * - the token works without auth and shows the frozen thread;
 * - sending as a signed-in viewer forks into THEIR session and navigates
 *   to /chat/<newId> without changing the shared snapshot;
 * - deactivating turns every link of the session off at once;
 * - deleting the source session removes its links but forked sessions live on.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const API_ORIGIN =
  process.env.E2E_API_ORIGIN?.replace(/\/+$/, "") || "http://localhost:4312";

async function createDraft(request: APIRequestContext): Promise<string> {
  const response = await request.post(`${API_ORIGIN}/api/chat/sessions/draft`, {
    data: { projectId: null },
  });
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { sessionId: string }).sessionId;
}

async function seedChat(page: Page, title: string, seed: string): Promise<string> {
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
  await editor.click();
  await editor.pressSequentially(seed, { delay: 5 });
  const send = page.getByRole("button", { name: "Send", exact: true });
  const stop = page.getByRole("button", { name: "Stop" });
  if (await send.isVisible().catch(() => false)) {
    await send.click();
  } else {
    await editor.press("Enter");
  }
  // Wait for the run to settle: the Send button returns once the worker
  // finishes (a fast stub run may never paint the Stop button, so only
  // require it opportunistically before the authoritative Send check).
  await stop
    .waitFor({ state: "visible", timeout: 5_000 })
    .catch(() => undefined);
  await expect(send).toBeVisible({ timeout: 120_000 });
  return sessionId;
}

async function generateLink(
  request: APIRequestContext,
  sessionId: string,
): Promise<{ token: string; urlPath: string }> {
  const response = await request.post(
    `${API_ORIGIN}/api/chat/sessions/${sessionId}/shares`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as { token: string; urlPath: string };
}

test.describe("public share links", () => {
  test("generate → anonymous read shows the frozen thread", async ({
    page,
    request,
  }) => {
    const stamp = Date.now();
    const sessionId = await createDraft(request);
    await request.patch(`${API_ORIGIN}/api/chat/sessions/${sessionId}`, {
      data: { title: `share-src-${stamp}` },
    });
    const { token, urlPath } = await generateLink(request, sessionId);
    expect(token.length).toBeGreaterThanOrEqual(21);
    expect(token).not.toContain(sessionId);
    expect(urlPath).toBe(`/share/${token}`);

    // Use a fresh context without the e2e auth cookie: the share page
    // must be readable anonymously.
    await page.context().clearCookies();
    await page.goto(urlPath);
    await expect(
      page.getByRole("heading", { name: `share-src-${stamp}` }),
    ).toBeVisible({ timeout: 30_000 });
    // No workspace sidebar on the public page.
    await expect(page.locator("aside")).toHaveCount(0);
    // Anonymous: login/register CTA at the bottom, no composer.
    await expect(
      page.getByRole("link", { name: /log in/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /sign up/i }).first(),
    ).toBeVisible();
    await expect(
      page.locator("[data-anvia-composer-editor]"),
    ).toHaveCount(0);
  });

  test("signed-in send forks an independent copy", async ({ page }) => {
    const stamp = Date.now();
    const sessionId = await seedChat(
      page,
      `share-fork-${stamp}`,
      `share seed ${stamp}`,
    );
    const { urlPath } = await generateLink(page.request, sessionId);

    await page.goto(urlPath);
    const followUp = page.getByPlaceholder(/follow-up/i);
    await expect(followUp).toBeVisible({ timeout: 30_000 });
    await followUp.click();
    await followUp.pressSequentially("what about the second part?", {
      delay: 5,
    });
    await page.getByRole("button", { name: /send as my copy/i }).click();
    await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+/, {
      timeout: 30_000,
    });
    const forkId = page.url().split("/chat/")[1]!.split(/[?#]/)[0]!;
    expect(forkId).not.toBe(sessionId);

    // The shared snapshot is unchanged by the fork's first message.
    await page.goto(urlPath);
    await expect(
      page.getByRole("heading", { name: `share-fork-${stamp}` }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("what about the second part?")).toHaveCount(
      0,
    );
  });

  test("deactivate turns every link off at once", async ({
    page,
    request,
  }) => {
    const sessionId = await createDraft(request);
    const first = await generateLink(request, sessionId);
    const second = await generateLink(request, sessionId);
    expect(second.token).not.toBe(first.token);

    const deactivated = await request.post(
      `${API_ORIGIN}/api/chat/sessions/${sessionId}/shares/deactivate`,
    );
    expect(deactivated.ok()).toBe(true);

    await page.goto(`/share/${first.token}`);
    await expect(
      page.getByRole("heading", { name: /not found/i }),
    ).toBeVisible({ timeout: 30_000 });
    await page.goto(`/share/${second.token}`);
    await expect(
      page.getByRole("heading", { name: /not found/i }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("deleting the source removes links but forks live on", async ({
    page,
  }) => {
    const stamp = Date.now();
    const sessionId = await seedChat(
      page,
      `share-del-${stamp}`,
      `share delete seed ${stamp}`,
    );
    const { urlPath } = await generateLink(page.request, sessionId);

    await page.goto(urlPath);
    const followUp = page.getByPlaceholder(/follow-up/i);
    await expect(followUp).toBeVisible({ timeout: 30_000 });
    await followUp.click();
    await followUp.pressSequentially("fork before delete", { delay: 5 });
    await page.getByRole("button", { name: /send as my copy/i }).click();
    await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+/, {
      timeout: 30_000,
    });
    const forkId = page.url().split("/chat/")[1]!.split(/[?#]/)[0]!;

    const deleted = await page.request.delete(
      `${API_ORIGIN}/api/chat/sessions/${sessionId}?confirm=true`,
    );
    expect(deleted.ok()).toBe(true);

    await page.goto(urlPath);
    await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible({
      timeout: 30_000,
    });
    await page.goto(`/chat/${forkId}`);
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("owner popover generates once and tracks status", async ({ page }) => {
    const stamp = Date.now();
    const sessionId = await seedChat(
      page,
      `share-pop-${stamp}`,
      `share popover seed ${stamp}`,
    );
    await page.goto(`/chat/${sessionId}`);
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });

    const shareButton = page
      .getByRole("button", { name: /share chat|sharing on/i })
      .first();
    await expect(shareButton).toBeVisible({ timeout: 30_000 });
    await shareButton.click();
    await expect(page.getByRole("dialog", { name: /share chat/i })).toBeVisible(
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: /generate link/i }).click();
    await expect(page.getByText(/shown once/i)).toBeVisible({
      timeout: 30_000,
    });
    // Close drops the token: reopening shows status only, never the link.
    await page.getByRole("button", { name: /^done$/i }).click();
    const reopenButton = page
      .getByRole("button", { name: /share chat|sharing on/i })
      .first();
    await expect(reopenButton).toBeVisible({ timeout: 30_000 });
    await reopenButton.click();
    await expect(page.getByRole("dialog", { name: /share chat/i })).toBeVisible(
      { timeout: 30_000,
      },
    );
    await expect(page.getByText(/shared link active/i)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(/shown once/i)).toHaveCount(0);
    // Topbar badge reflects the active state.
    await page.getByRole("button", { name: /^done$/i }).click();
    await expect(
      page.getByRole("button", { name: /sharing on/i }).first(),
    ).toBeVisible({ timeout: 30_000 });
  });
});

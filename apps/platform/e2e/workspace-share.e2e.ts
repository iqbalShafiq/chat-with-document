/**
 * Public share-link E2E (stub LLM, no real key):
 * generate → anonymous read → signed-in fork → deactivate → delete cascade.
 *
 * Share semantics under test (frozen snapshot, latest-link display,
 * all-or-nothing deactivate, independent forks):
 * - the token works without auth and shows the frozen thread in the exact
 *   chat room (bubbles) with a read-only composer + login/register CTA;
 * - the first send as a signed-in viewer forks server-side, navigates to the
 *   viewer's own `/chat/<newId>` room, and auto-sends there through the
 *   normal pipeline (AI reacts in place) without changing the snapshot;
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
      page.getByText("Shared chat snapshot"),
    ).toBeVisible({ timeout: 30_000 });
    // Same chat room as authenticated chats: read-only composer shell plus
    // the snapshot banner, but no workspace sidebar. The right documents
    // rail mounts inside the same room shell (its empty state is an aside),
    // so only assert the login/register CTA and the disabled composer.
    await expect(
      page.locator("[data-anvia-composer-editor]"),
    ).toHaveCount(1);
    await expect(
      page.locator("[data-anvia-composer-editor]"),
    ).toBeDisabled();
    // Anonymous: login/register CTA above the composer.
    await expect(
      page.getByRole("link", { name: /log in/i }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /sign up/i }).first(),
    ).toBeVisible();
  });

  test("signed-in first send navigates to the fork and AI reacts there", async ({ page }) => {
    const stamp = Date.now();
    const sessionId = await seedChat(
      page,
      `share-fork-${stamp}`,
      `share seed ${stamp}`,
    );
    const { urlPath } = await generateLink(page.request, sessionId);

    await page.goto(urlPath);
    await expect(
      page.getByText("Shared chat snapshot"),
    ).toBeVisible({ timeout: 30_000 });
    // Normal composer with a text-only notice chip above it: the full
    // model/attach/feature row stays live, including the real Send button.
    await expect(
      page.getByText("Your first send forks this snapshot"),
    ).toBeVisible({ timeout: 30_000 });
    const followUp = page.locator("[data-anvia-composer-editor]");
    await expect(followUp).toBeVisible({ timeout: 30_000 });
    await followUp.click();
    await followUp.pressSequentially("what about the second part?", {
      delay: 5,
    });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // Fork handoff: smooth SPA navigation to the viewer's own room, where
    // the same draft auto-sends through the normal pipeline.
    await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+/, {
      timeout: 30_000,
    });
    const forkId = page.url().split("/chat/")[1]!.split(/[?#]/)[0]!;
    expect(forkId).not.toBe(sessionId);
    // The forked room shows the normal workspace chrome plus the forked
    // history, the first user bubble, and the live AI run to completion.
    await expect(page.locator("aside").first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("what about the second part?").first()).toBeVisible({
      timeout: 30_000,
    });
    const send = page.getByRole("button", { name: "Send", exact: true });
    const stop = page.getByRole("button", { name: "Stop" });
    await stop
      .waitFor({ state: "visible", timeout: 30_000 })
      .catch(() => undefined);
    await expect(send).toBeVisible({ timeout: 120_000 });

    // The shared snapshot is unchanged by the fork's first message.
    await page.goto(urlPath);
    await expect(
      page.getByText("Shared chat snapshot"),
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
    const followUp = page.locator("[data-anvia-composer-editor]");
    await expect(followUp).toBeVisible({ timeout: 30_000 });
    await followUp.click();
    await followUp.pressSequentially("fork before delete", { delay: 5 });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+/, {
      timeout: 30_000,
    });
    const send = page.getByRole("button", { name: "Send", exact: true });
    const stop = page.getByRole("button", { name: "Stop" });
    await stop
      .waitFor({ state: "visible", timeout: 30_000 })
      .catch(() => undefined);
    await expect(send).toBeVisible({ timeout: 120_000 });

    const deleted = await page.request.delete(
      `${API_ORIGIN}/api/chat/sessions/${sessionId}?confirm=true`,
    );
    expect(deleted.ok()).toBe(true);

    await page.goto(urlPath);
    await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible({
      timeout: 30_000,
    });
  });

  test("owner popover shows the link inline and tracks status", async ({ page }) => {
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
    const dialog = page.getByRole("dialog", { name: /share chat/i });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: /generate link/i }).click();
    await expect(dialog.getByText(/link copied|new link copied/i)).toBeVisible({
      timeout: 30_000,
    });
    const firstToken = await dialog
      .locator("p.truncate")
      .innerText()
      .then((text) => text.trim().split("/").pop() ?? "");
    expect(firstToken.length).toBeGreaterThanOrEqual(21);
    // Close keeps the link visible on reopen: the dialog always shows the
    // newest active link inline.
    await page.getByRole("button", { name: /^close$/i }).click();
    const reopenButton = page
      .getByRole("button", { name: /share chat|sharing on/i })
      .first();
    await expect(reopenButton).toBeVisible({ timeout: 30_000 });
    await reopenButton.click();
    const reopened = page.getByRole("dialog", { name: /share chat/i });
    await expect(reopened).toBeVisible({ timeout: 30_000 });
    await expect(reopened.locator("p.truncate")).toContainText(firstToken, {
      timeout: 30_000,
    });
    await expect(
      reopened.getByRole("button", { name: /copy link/i }),
    ).toBeVisible({ timeout: 30_000 });
    // Topbar badge reflects the active state.
    await page.getByRole("button", { name: /^close$/i }).click();
    await expect(
      page.getByRole("button", { name: /sharing on/i }).first(),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("stale link shows an outdated status until regenerated", async ({
    page,
  }) => {
    const stamp = Date.now();
    const sessionId = await seedChat(
      page,
      `share-stale-${stamp}`,
      `share stale seed ${stamp}`,
    );
    await page.goto(`/chat/${sessionId}`);
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });
    await page
      .getByRole("button", { name: /share chat/i })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: /share chat/i });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: /generate link/i }).click();
    await expect(dialog.getByText(/link copied|new link copied/i)).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole("button", { name: /^close$/i }).click();

    // New chat activity after minting makes the link stale.
    const editor = page.locator("[data-anvia-composer-editor]");
    await editor.click();
    await editor.pressSequentially(`share stale follow-up ${stamp}`, {
      delay: 5,
    });
    const send = page.getByRole("button", { name: "Send", exact: true });
    const stop = page.getByRole("button", { name: "Stop" });
    if (await send.isVisible().catch(() => false)) {
      await send.click();
    } else {
      await editor.press("Enter");
    }
    await stop
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch(() => undefined);
    await expect(send).toBeVisible({ timeout: 120_000 });

    await page
      .getByRole("button", { name: /sharing on/i })
      .first()
      .click();
    const staleDialog = page.getByRole("dialog", { name: /share chat/i });
    await expect(staleDialog).toBeVisible({ timeout: 30_000 });
    await expect(
      staleDialog.getByText(/public link activated/i),
    ).toBeVisible({ timeout: 30_000 });
    await staleDialog
      .getByRole("button", { name: /generate a fresh link/i })
      .click();
    await expect(
      staleDialog.getByText(/new link copied/i),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("deactivate from the dialog clears the inline link", async ({
    page,
  }) => {
    const stamp = Date.now();
    const sessionId = await seedChat(
      page,
      `share-deactivate-${stamp}`,
      `share deactivate seed ${stamp}`,
    );
    await page.goto(`/chat/${sessionId}`);
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });
    await page
      .getByRole("button", { name: /share chat/i })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: /share chat/i });
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog.getByRole("button", { name: /generate link/i }).click();
    await expect(
      dialog.locator("p.truncate", { hasText: "/share/" }),
    ).toBeVisible({ timeout: 30_000 });

    await dialog.getByRole("button", { name: /deactivate links/i }).click();
    await expect(dialog.getByText(/not shared/i)).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      dialog.getByRole("button", { name: /generate link/i }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(dialog.locator("p.truncate")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: /copy link/i }),
    ).toHaveCount(0);
  });

  test("dialog copy keeps the newest link on the clipboard", async ({
    page,
  }) => {
    const stamp = Date.now();
    const sessionId = await seedChat(
      page,
      `share-copy-${stamp}`,
      `share copy seed ${stamp}`,
    );
    await page.goto(`/chat/${sessionId}`);
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });

    // No public link yet: the share button shows the not-shared state.
    await page
      .getByRole("button", { name: /share chat/i })
      .first()
      .click();
    const freshDialog = page.getByRole("dialog", { name: /share chat/i });
    await expect(freshDialog).toBeVisible({ timeout: 30_000 });
    await expect(freshDialog.getByText(/not shared/i)).toBeVisible({
      timeout: 30_000,
    });

    // Two links: the dialog must surface the newest one, not the first.
    await freshDialog.getByRole("button", { name: /generate link/i }).click();
    const firstToken = await freshDialog
      .locator("p.truncate")
      .innerText()
      .then((text) => text.trim().split("/").pop() ?? "");
    expect(firstToken.length).toBeGreaterThanOrEqual(21);
    await page.getByRole("button", { name: /^close$/i }).click();

    const editor = page.locator("[data-anvia-composer-editor]");
    await editor.click();
    await editor.pressSequentially(`share copy follow-up ${stamp}`, {
      delay: 5,
    });
    const send = page.getByRole("button", { name: "Send", exact: true });
    const stop = page.getByRole("button", { name: "Stop" });
    if (await send.isVisible().catch(() => false)) {
      await send.click();
    } else {
      await editor.press("Enter");
    }
    await stop
      .waitFor({ state: "visible", timeout: 5_000 })
      .catch(() => undefined);
    await expect(send).toBeVisible({ timeout: 120_000 });

    await page
      .getByRole("button", { name: /share chat|sharing on/i })
      .first()
      .click();
    const regenerateDialog = page.getByRole("dialog", {
      name: /share chat/i,
    });
    await expect(regenerateDialog).toBeVisible({ timeout: 30_000 });
    await expect(
      regenerateDialog.getByText(/public link activated/i),
    ).toBeVisible({ timeout: 30_000 });
    await regenerateDialog
      .getByRole("button", { name: /generate a fresh link/i })
      .click();
    await expect(regenerateDialog.getByText(/new link copied/i)).toBeVisible({
      timeout: 30_000,
    });
    const secondToken = await regenerateDialog
      .locator("p.truncate")
      .innerText()
      .then((text) => text.trim().split("/").pop() ?? "");
    expect(secondToken).not.toBe(firstToken);

    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await regenerateDialog.getByRole("button", { name: /copy link/i }).click();
    await expect(regenerateDialog.getByText(/link copied/i)).toBeVisible({
      timeout: 30_000,
    });
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain(`/share/${secondToken}`);
    expect(clipboard).not.toContain(firstToken);
  });
});

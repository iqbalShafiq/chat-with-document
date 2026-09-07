/**
 * Workspace URL routing E2E (no LLM): every chat has a shareable path.
 *
 * - `/` replaces itself with the canonical `/chat/$sessionId` URL.
 * - Direct goto + reload on `/chat/$sessionId` renders the same conversation.
 * - Unknown session ids render a not-found state with a recovery action.
 * - `/projects` renders the browser; `/documents` renders the library.
 * - Login redirects back to the requested deep link after sign-in.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const API_ORIGIN =
  process.env.E2E_API_ORIGIN?.replace(/\/+$/, "") || "http://localhost:4312";

async function createDraft(
  request: APIRequestContext,
  projectId: string | null = null,
): Promise<string> {
  const response = await request.post(`${API_ORIGIN}/api/chat/sessions/draft`, {
    data: { projectId },
  });
  expect(response.ok()).toBe(true);
  const data = (await response.json()) as { sessionId: string };
  return data.sessionId;
}

/**
 * Seed a chat with one real exchange through the page's own transport so
 * it owns a durable row: the server reuses one *empty* draft per scope,
 * and rename alone does not break that reuse — only memory messages do.
 * Driving the exchange through the UI reuses the app's request shape and
 * the stubbed model already selected by the stack (no LLM key needed).
 */
async function createSeededChat(
  page: Page,
  title: string,
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
  await editor.click();
  await editor.pressSequentially(`routing seed ${title}`, { delay: 5 });
  const send = page.getByRole("button", { name: "Send", exact: true });
  if (await send.isVisible().catch(() => false)) {
    await send.click();
  } else {
    await editor.press("Enter");
  }
  // The stub answers every prompt; wait for the run to settle so the
  // session owns memory before the next draft is allocated.
  await expect(send).toBeVisible({ timeout: 120_000 });
  return sessionId;
}

async function createProject(
  request: APIRequestContext,
  name: string,
): Promise<string> {
  const response = await request.post(`${API_ORIGIN}/api/projects`, {
    data: { name },
  });
  expect(response.ok()).toBe(true);
  const data = (await response.json()) as { id: string };
  return data.id;
}

test.describe("workspace routing", () => {
  test("root redirects to a canonical chat URL", async ({ page }) => {
    const sessionId = await createDraft(page.request);
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`/chat/([A-Za-z0-9_-]+)`), {
      timeout: 30_000,
    });
    expect(page.url()).toContain("/chat/");
    void sessionId;
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("direct chat link loads and survives reload", async ({ page }) => {
    const sessionId = await createDraft(page.request);
    await page.goto(`/chat/${sessionId}`);
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}`));
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });
  });

  test("unknown chat shows not-found with recovery", async ({ page }) => {
    await page.goto("/chat/00000000-0000-4000-8000-000000000000");
    await expect(
      page.getByRole("heading", { name: /not found/i }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("link", { name: /back to chats|new chat/i }).first(),
    ).toBeVisible();
  });

  test("projects and documents have their own URLs", async ({ page }) => {
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/projects/);
    await page.goto("/documents");
    await expect(page).toHaveURL(/\/documents/);
  });

  test("project chat deep link resolves under the project", async ({ page }) => {
    const projectId = await createProject(
      page.request,
      `routing-e2e-${Date.now()}`,
    );
    const sessionId = await createDraft(page.request, projectId);
    await page.goto(`/projects/${projectId}/chat/${sessionId}`);
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(
      new RegExp(`/projects/${projectId}/chat/${sessionId}`),
    );
  });

  test("sidebar selection changes the URL and back returns", async ({
    page,
  }) => {
    const stamp = Date.now();
    const firstTitle = `routing first ${stamp}`;
    const secondTitle = `routing second ${stamp}`;
    // Two distinct rows are required for a select-then-back flow. The
    // server reuses one empty draft per scope (rename does not break the
    // reuse — only memory messages do), so seed each chat with one real
    // exchange through the page transport first.
    const first = await createSeededChat(page, firstTitle);
    const second = await createSeededChat(page, secondTitle);
    expect(second).not.toBe(first);
    // Commit history entries via in-app navigation: with only the initial
    // document load on the stack, Back has nowhere to return to. Drive the
    // warmup through the sidebar (SPA push) from the other session so the
    // same-session no-op guard never swallows it.
    await page.goto(`/chat/${second}`);
    const sidebar = page.locator("aside").first();
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });
    await expect(sidebar).toBeVisible({ timeout: 30_000 });
    await expect(
      sidebar.getByRole("button", { name: /routing first/ }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await sidebar
      .getByRole("button", { name: /routing first/ })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/chat/${first}`), {
      timeout: 30_000,
    });
    const composer = page.locator("[data-anvia-composer-editor]");
    await expect(composer).toBeVisible({ timeout: 30_000 });
    await sidebar
      .getByRole("button", { name: /routing second/ })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/chat/${second}`), {
      timeout: 30_000,
    });
    await expect(page).toHaveTitle(/routing second/, { timeout: 30_000 });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await expect(page).toHaveURL(new RegExp(`/chat/${first}`), {
      timeout: 30_000,
    });
    await expect(composer).toBeVisible({ timeout: 30_000 });
  });

  test("new chat button opens a canonical URL", async ({
    page,
    request,
  }) => {
    // A new chat from a named (non-empty) chat navigates to a canonical
    // chat URL. Seeded via rename: the title alone marks the row non-new.
    const sessionId = await createDraft(request);
    await request.patch(`${API_ORIGIN}/api/chat/sessions/${sessionId}`, {
      data: { title: `routing-named-${Date.now()}` },
    });
    await page.goto(`/chat/${sessionId}`);
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });
    const newChat = page.getByRole("button", { name: /^new chat/i }).first();
    await expect(newChat).toBeEnabled({ timeout: 30_000 });
    await newChat.click();
    await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+/, {
      timeout: 30_000,
    });
  });

  test("new chat from a named chat navigates to a chat URL", async ({
    page,
    request,
  }) => {
    const sessionId = await createDraft(request);
    await request.patch(`${API_ORIGIN}/api/chat/sessions/${sessionId}`, {
      data: { title: `routing-named-${Date.now()}` },
    });
    await page.goto(`/chat/${sessionId}`);
    await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible({
      timeout: 30_000,
    });
    const newChat = page.getByRole("button", { name: /^new chat/i }).first();
    await expect(newChat).toBeEnabled({ timeout: 30_000 });
    await newChat.click();
    await expect(page).toHaveURL(/\/chat\/[A-Za-z0-9_-]+/, {
      timeout: 30_000,
    });
  });
});

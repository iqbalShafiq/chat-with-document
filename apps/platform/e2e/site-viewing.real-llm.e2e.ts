/**
 * Site viewing acceptance with the real stack and real LLM.
 * Spec: docs/superpowers/specs/2026-09-25-site-viewing-design.md
 * Plan: docs/superpowers/plans/2026-09-25-site-viewing.md (Task 7)
 * Prerequisites:
 *   - `pnpm dev` running (API :4312, platform :3000, worker) with
 *     OPENAI_BASE_URL=https://openrouter.ai/api/v1 and a real OPENAI_API_KEY.
 *   - Run: `E2E_API_ORIGIN=http://localhost:4312 pnpm --filter @anreal/platform exec playwright test --config playwright.real-llm.config.ts e2e/site-viewing.real-llm.e2e.ts`
 * Signs in as shafiq@testing.com (registers first when missing).
 * Models: meta/muse-spark-1.3-contributor (vision) and
 * deepseek/deepseek-v4-flash-0731 (text-only).
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ORIGIN,
  expandAssistantToolPanels,
  sendMessage,
  waitForRunDone,
  waitForStreaming,
} from "./helpers";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(E2E_DIR, "../../.playwright-mcp/site-viewing");

const TEST_EMAIL = "shafiq@testing.com";
const TEST_PASSWORD = "Test@123";
const TEST_NAME = "Shafiq Testing";
const TEXT_ONLY_MODEL = "deepseek/deepseek-v4-flash-0731";
const TAG = `siteview-${Date.now().toString(36)}`;

function lastAssistant(page: Page) {
  return page.locator('article[data-role="assistant"]').last();
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

async function pollFor<T>(
  fn: () => Promise<T[]>,
  match: (item: T) => boolean,
  timeoutMs = 600_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const items = await fn();
    const found = items.find(match);
    if (found) return found;
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for expected site");
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

async function saveEvidence(page: Page, caseId: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: resolve(EVIDENCE_DIR, `${caseId}.png`) });
}

async function setModelExact(page: Page, modelId: string): Promise<void> {
  // Exact aria-label match: the shared helper uses substring matching and can
  // hit a different "Model" button, leaving the menu closed.
  const trigger = page.locator('button[aria-label="Model"]');
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  const option = page.locator(`[data-option-value="${modelId}"]`);
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
}

async function setEffortExact(page: Page, effort: string): Promise<void> {
  const trigger = page.locator('button[aria-label="Reasoning effort"]');
  await expect(trigger).toBeEnabled({ timeout: 30_000 });
  await trigger.click();
  const option = page.locator(`[data-option-value="${effort}"]`);
  await expect(option).toBeVisible({ timeout: 15_000 });
  await option.click();
}

async function openChatWithModel(page: Page, modelId: string, effort?: string): Promise<string> {
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
  // Model menu options render only after the catalog loads; the trigger is
  // disabled until then — clicking earlier swallows the open.
  await setModelExact(page, modelId);
  if (effort) {
    try {
      await setEffortExact(page, effort);
    } catch {
      await page.keyboard.press("Escape");
    }
  }
  return sessionId;
}

async function buildTaggedSite(page: Page): Promise<{
  sessionId: string;
  siteId: string;
  siteLabel: string;
}> {
  await ensureTestUser(page);
  const sessionId = await openChatWithModel(page, "meta/muse-spark-1.3-contributor", "high");
  await sendMessage(
    page,
    `Buatkan landing page statis super sederhana bernama ${TAG}: satu halaman saja, hero berisi judul "${TAG}", satu paragraf pendek tentang kopi, tanpa gambar.`,
  );
  await waitForRunDone(page, 600_000);
  // The artifacts list now labels sites by their brief name; match the build
  // session to find our row, then pin by the label the picker actually shows.
  const site = await pollFor(
    async () => {
      try {
        const res = await page.request.get(
          `${API_ORIGIN}/api/artifacts?type=site&sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!res.ok()) return [];
        return (
          (await res.json()) as {
            items: { id?: string; sessionId?: string; status?: string; title?: string }[];
          }
        ).items;
      } catch {
        return [];
      }
    },
    (s) => s.sessionId === sessionId && s.status === "ready",
    600_000,
  );
  const siteId = site.id ?? "";
  expect(siteId.length).toBeGreaterThan(0);
  return { sessionId, siteId, siteLabel: site.title ?? siteId };
}

function exactLabelPattern(label: string): RegExp {
  return new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

async function pinTaggedSite(page: Page, siteLabel: string): Promise<void> {
  await page.getByRole("button", { name: "Attach document", exact: true }).click();
  await page.getByRole("menuitem", { name: /pin a site/i }).click();
  await page.getByRole("radio", { name: exactLabelPattern(siteLabel) }).click();
  await page.getByRole("list", { name: "Pinned artifacts" }).waitFor({ timeout: 30_000 });
}

const REVIEW_PROMPT =
  "Review desain site yang saya pin ini. Sebutkan 3 hal spesifik yang kamu lihat: warna dominan, isi teks hero, dan satu saran perbaikan. Jawab ringkas.";

const VISUAL_HINTS = /warna|putih|hitam|bersih|minimalis|polos|desain|hero|cta|layout|color|colour|font|teks/i;

/** Read the session's persisted messages (same cookie context as the page). */
async function sessionMessages(
  page: Page,
  sessionId: string,
): Promise<Array<{ role: string; content?: Array<Record<string, unknown>> }>> {
  const response = await page.request.get(
    `${API_ORIGIN}/api/chat?sessionId=${encodeURIComponent(sessionId)}`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as Array<{ role: string; content?: Array<Record<string, unknown>> }>;
}

/** Extract the view_site_page tool result JSON from persisted history. */
export async function viewSiteResult(
  page: Page,
  sessionId: string,
): Promise<Record<string, unknown> | null> {
  const messages = await sessionMessages(page, sessionId);
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type !== "tool-result" || part.toolName !== "view_site_page") continue;
      const output = part.output as { type?: string; value?: unknown } | undefined;
      // JSON output (text-only path or legacy) carries the object directly.
      if (
        output?.type === "json" &&
        typeof output.value === "object" &&
        output.value !== null &&
        !Array.isArray(output.value)
      ) {
        return output.value as Record<string, unknown>;
      }
      // Rich content output: find the JSON text part and parse it.
      if (Array.isArray(output?.value)) {
        const text = (output.value as Array<{ type: string; text?: string }>).find(
          (entry) => entry.type === "text",
        )?.text;
        if (typeof text === "string") {
          return JSON.parse(text) as Record<string, unknown>;
        }
      }
    }
  }
  return null;
}

/** Poll the persisted history until view_site_page lands (run may still be finishing). */
async function waitForViewResult(
  page: Page,
  sessionId: string,
): Promise<Record<string, unknown>> {
  let found: Record<string, unknown> | null = null;
  await expect
    .poll(
      async () => {
        found = await viewSiteResult(page, sessionId);
        return found !== null;
      },
      { timeout: 300_000, intervals: [5_000] },
    )
    .toBe(true);
  return found!;
}

test.describe.serial("agent site viewing", () => {
  let built: { sessionId: string; siteId: string; siteLabel: string };

  test("vision model reviews a pinned site without asking for screenshots", async ({ page }) => {
    test.setTimeout(1_200_000);
    built = await buildTaggedSite(page);
    const reviewSessionId = await openChatWithModel(page, "meta/muse-spark-1.3-contributor", "high");
    await pinTaggedSite(page, built.siteLabel);
    await sendMessage(page, REVIEW_PROMPT);
    await waitForRunDone(page, 600_000);

    // Verify the tool result FIRST (poll until persisted), then the UI.
    const result = await waitForViewResult(page, reviewSessionId);
    expect(typeof result.imageId).toBe("string");
    expect((result.imageId as string).length).toBeGreaterThan(0);
    expect(result.imageBytesIncluded).toBe(true);
    expect(result.captureError).toBeNull();

    const answer = lastAssistant(page);
    await expect(answer).not.toContainText("[@site", { timeout: 30_000 });
    await expect(answer).not.toContainText(/belum bisa (melihat|lihat)/i);
    await expect(answer).toContainText(VISUAL_HINTS);
    await expandAssistantToolPanels(page);
    // Tool calls render in earlier assistant articles, not the last one.
    await expect
      .poll(async () => page.locator('article[data-role="assistant"]').allTextContents(), {
        timeout: 30_000,
      })
      .toContainEqual(expect.stringContaining("view_site_page"));
    await saveEvidence(page, "siteview-vision");
  });

  test("text-only model describes the pinned site via view_image", async ({ page }) => {
    test.setTimeout(1_200_000);
    await ensureTestUser(page);
    const reviewSessionId = await openChatWithModel(page, TEXT_ONLY_MODEL);
    await pinTaggedSite(page, built.siteLabel);
    const editor = page.locator("[data-anvia-composer-editor]");
    await editor.click();
    await editor.pressSequentially(REVIEW_PROMPT, { delay: 15 });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    // The Send button is still visible for a beat before the run flips the
    // composer to Stop — wait for the stream before waiting for it to end.
    await waitForStreaming(page);
    await waitForRunDone(page, 600_000);

    // Verify the tool result FIRST (poll until persisted), then the UI.
    const result = await waitForViewResult(page, reviewSessionId);
    expect((result.imageId as string).length).toBeGreaterThan(0);
    // Text-only runs must not claim inline bytes; view_image is the path.
    expect(result.imageBytesIncluded).toBe(false);

    const answer = lastAssistant(page);
    await expect(answer).not.toContainText("[@site", { timeout: 30_000 });
    await expect(answer).not.toContainText(/belum bisa (melihat|lihat)/i);
    await expect(answer).toContainText(VISUAL_HINTS);
    await expandAssistantToolPanels(page);
    // Tool calls render in earlier assistant articles, not the last one.
    const transcripts = () => page.locator('article[data-role="assistant"]').allTextContents();
    await expect.poll(transcripts, { timeout: 30_000 }).toContainEqual(
      expect.stringContaining("view_site_page"),
    );
    await expect.poll(transcripts, { timeout: 30_000 }).toContainEqual(
      expect.stringContaining("view_image"),
    );
    await saveEvidence(page, "siteview-textonly");
  });
});

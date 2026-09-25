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

async function buildTaggedSite(page: Page): Promise<{ sessionId: string; siteId: string }> {
  await ensureTestUser(page);
  const sessionId = await openChatWithModel(page, "meta/muse-spark-1.3-contributor", "high");
  await sendMessage(
    page,
    `Buatkan landing page statis super sederhana bernama ${TAG}: satu halaman saja, hero berisi judul "${TAG}", satu paragraf pendek tentang kopi, tanpa gambar.`,
  );
  await waitForRunDone(page, 600_000);
  const site = await pollFor(
    async () => {
      // Dev API memakai tsx --watch: site build menulis ribuan file ke
      // data/sites sehingga server bisa restart mid-run. ECONNREFUSED
      // sesaat = daftar kosong, bukan kegagalan — polling lanjut.
      try {
        const res = await page.request.get(
          `${API_ORIGIN}/api/sites?sessionId=${encodeURIComponent(sessionId)}`,
        );
        if (!res.ok()) return [];
        return ((await res.json()) as {
          sites: { siteId: string; sessionId: string; status: string; previewUrl: string | null }[];
        }).sites;
      } catch {
        return [];
      }
    },
    (s) => s.sessionId === sessionId && s.status === "ready",
    600_000,
  );
  expect(site.previewUrl).toBeTruthy();
  return { sessionId, siteId: site.siteId };
}

async function pinTaggedSite(page: Page, buildSessionId: string): Promise<void> {
  await page.getByRole("button", { name: "Attach document", exact: true }).click();
  await page.getByRole("menuitem", { name: /pin a site/i }).click();
  // Site rows are labeled by their build session id (sites carry no title).
  await page.getByRole("radio", { name: new RegExp(buildSessionId.slice(0, 8), "i") }).click();
  await page.getByRole("list", { name: "Pinned artifacts" }).waitFor({ timeout: 30_000 });
}

const REVIEW_PROMPT =
  "Review desain site yang saya pin ini. Sebutkan 3 hal spesifik yang kamu lihat: warna dominan, isi teks hero, dan satu saran perbaikan. Jawab ringkas.";

test.describe.serial("agent site viewing", () => {
  let built: { sessionId: string; siteId: string };

  test("vision model reviews a pinned site without asking for screenshots", async ({ page }) => {
    test.setTimeout(1_200_000);
    built = await buildTaggedSite(page);
    await openChatWithModel(page, "meta/muse-spark-1.3-contributor", "high");
    await pinTaggedSite(page, built.sessionId);
    await sendMessage(page, REVIEW_PROMPT);
    await waitForRunDone(page, 600_000);

    const answer = lastAssistant(page);
    await expect(answer).not.toContainText("[@site", { timeout: 30_000 });
    await expect(answer).not.toContainText(/belum bisa (melihat|lihat)/i);
    await expect(answer).toContainText(/warna/i);
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
    await openChatWithModel(page, TEXT_ONLY_MODEL);
    await pinTaggedSite(page, built.sessionId);
    const editor = page.locator("[data-anvia-composer-editor]");
    await editor.click();
    await editor.pressSequentially(REVIEW_PROMPT, { delay: 15 });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await waitForRunDone(page, 600_000);

    const answer = lastAssistant(page);
    await expect(answer).not.toContainText("[@site", { timeout: 30_000 });
    await expect(answer).not.toContainText(/belum bisa (melihat|lihat)/i);
    await expect(answer).toContainText(/warna/i);
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

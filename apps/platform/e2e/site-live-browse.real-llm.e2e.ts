/**
 * Live site browse acceptance with the real stack and real LLM.
 * Spec: docs/superpowers/specs/2026-09-26-agent-live-site-browse-design.md
 * Plan: docs/superpowers/plans/2026-09-26-agent-live-site-browse.md (Task 7)
 * Prerequisites:
 *   - `pnpm dev` running (API :4312, platform :3000, worker) with
 *     OPENAI_BASE_URL and a real OPENAI_API_KEY.
 *   - Run: `E2E_API_ORIGIN=http://localhost:4312 pnpm --filter @anreal/platform exec playwright test --config playwright.real-llm.config.ts e2e/site-live-browse.real-llm.e2e.ts`
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
const EVIDENCE_DIR = resolve(E2E_DIR, "../../.playwright-mcp/site-live-browse");

const TEST_EMAIL = "shafiq@testing.com";
const TEST_PASSWORD = "Test@123";
const TEST_NAME = "Shafiq Testing";
const VISION_MODEL = "meta/muse-spark-1.3-contributor";
const TEXT_ONLY_MODEL = "deepseek/deepseek-v4-flash-0731";
const TAG = `livebrowse-${Date.now().toString(36)}`;

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

const BUILD_PROMPT = `Buatkan landing page statis bernama ${TAG} dalam satu halaman: seksi id "tentang" berisi teks TENTANG-KEDAI, seksi id "kontak" berisi teks KONTAK-KAMI, dan link navigasi berteks "Kontak" dengan href "#kontak". Tanpa gambar dan tanpa JavaScript.`;

async function buildTwoSectionSite(page: Page): Promise<{
  sessionId: string;
  siteId: string;
  siteLabel: string;
}> {
  await ensureTestUser(page);
  const sessionId = await openChatWithModel(page, VISION_MODEL, "high");
  await sendMessage(page, BUILD_PROMPT);
  await waitForRunDone(page, 600_000);
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

const BROWSE_PROMPT =
  "Buka site yang saya pin dengan browse_site: scroll ke bawah, klik link 'Kontak', lalu sebutkan teks yang ada di seksi kontak. Jawab singkat.";

/** Poll the live frame endpoint while the run executes (frames are ephemeral). */
function startFrameProbe(page: Page, sessionId: string) {
  const state = { sawJpeg: false, polls: 0, stopped: false };
  const loop = (async () => {
    while (!state.stopped) {
      try {
        const response = await page.request.get(
          `${API_ORIGIN}/api/sites/live/${encodeURIComponent(sessionId)}/frame`,
        );
        state.polls += 1;
        const contentType = response.headers()["content-type"] ?? "";
        if (
          response.status() === 200 &&
          contentType.includes("image/jpeg") &&
          (await response.body()).length > 0
        ) {
          state.sawJpeg = true;
        }
      } catch {
        // Keep polling; the dev stack may restart mid-run.
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
  })();
  return {
    state,
    async stop() {
      state.stopped = true;
      await loop;
      return state;
    },
  };
}

async function expectBrowseToolCalls(page: Page, minCalls: number): Promise<void> {
  await expandAssistantToolPanels(page);
  const transcripts = () => page.locator('article[data-role="assistant"]').allTextContents();
  await expect
    .poll(
      async () => {
        const texts = await transcripts();
        return texts.filter((text) => text.includes("browse_site")).length;
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBeGreaterThanOrEqual(minCalls);
}

/** Tool names from the persisted session history (UI labels are humanized). */
async function toolResultNames(page: Page, sessionId: string): Promise<string[]> {
  try {
    const response = await page.request.get(
      `${API_ORIGIN}/api/chat?sessionId=${encodeURIComponent(sessionId)}`,
    );
    if (!response.ok()) return [];
    const messages = (await response.json()) as Array<{
      content?: Array<Record<string, unknown>>;
    }>;
    const names: string[] = [];
    for (const message of messages) {
      for (const part of message.content ?? []) {
        if (part.type === "tool-result" && typeof part.toolName === "string") {
          names.push(part.toolName);
        }
      }
    }
    return names;
  } catch {
    return [];
  }
}

async function expectContactSectionAnswer(answer: ReturnType<Page["locator"]>): Promise<void> {
  // The LLM-generated site rewrites literal copy, so assert the observable
  // claim instead: the answer is about the contact section and quotes it.
  await expect(answer).toContainText(/kontak/i, { timeout: 60_000 });
  await expect(answer).toContainText(/(hubungi|telepon|whatsapp|alamat|jam buka|email|call)/i, {
    timeout: 30_000,
  });
}

test.describe.serial("agent live site browse", () => {
  let built: { sessionId: string; siteId: string; siteLabel: string };

  test("vision model browses a pinned site with live frames", async ({ page }) => {
    test.setTimeout(1_800_000);
    built = await buildTwoSectionSite(page);
    const sessionId = await openChatWithModel(page, VISION_MODEL, "high");
    await pinTaggedSite(page, built.siteLabel);
    await sendMessage(page, BROWSE_PROMPT);

    const probe = startFrameProbe(page, sessionId);
    await waitForStreaming(page);
    // The live card appears when the worker publishes siteLiveView(started).
    await expect
      .poll(async () => page.getByRole("img", { name: /livestream/i }).count(), {
        timeout: 180_000,
        intervals: [1_000],
      })
      .toBeGreaterThan(0);
    await saveEvidence(page, "live-browse-vision");
    await waitForRunDone(page, 900_000);

    const frames = await probe.stop();
    expect(frames.sawJpeg).toBe(true);
    expect(frames.polls).toBeGreaterThan(0);

    await expectBrowseToolCalls(page, 3);
    const answer = lastAssistant(page);
    await expect(answer).not.toContainText("[@site", { timeout: 30_000 });
    await expectContactSectionAnswer(answer);
    await saveEvidence(page, "live-browse-vision-final");
  });

  test("text-only model resolves browse screenshots via view_image", async ({ page }) => {
    test.setTimeout(1_800_000);
    await ensureTestUser(page);
    const sessionId = await openChatWithModel(page, TEXT_ONLY_MODEL);
    await pinTaggedSite(page, built.siteLabel);
    // Manual send: the shared sendMessage helper asserts the muse model in the
    // run metadata, which does not hold for the text-only path.
    const editor = page.locator("[data-anvia-composer-editor]");
    await editor.click();
    await editor.pressSequentially(BROWSE_PROMPT, { delay: 15 });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await waitForStreaming(page);

    const probe = startFrameProbe(page, sessionId);
    await waitForRunDone(page, 900_000);

    const frames = await probe.stop();
    expect(frames.sawJpeg).toBe(true);

    await expectBrowseToolCalls(page, 1);
    // The UI humanizes tool labels ("Viewing image"); the persisted history
    // carries the real tool name, which is the stronger contract.
    await expect
      .poll(() => toolResultNames(page, sessionId), { timeout: 120_000, intervals: [5_000] })
      .toContain("view_image");
    const answer = lastAssistant(page);
    await expect(answer).not.toContainText("[@site", { timeout: 30_000 });
    await expectContactSectionAnswer(answer);
    await saveEvidence(page, "live-browse-textonly-final");
  });
});

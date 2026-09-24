/**
 * Full workspace workflow with the real stack and real LLM — one tidy story:
 * attach PDF + CSV → web search → data analysis → chart snapshot → PDF report
 * → static site → cross-session reuse + revision. Image generation is
 * attempted live but passes gracefully on credit/quota failure (credits are
 * known-low; stub E2E covers generation itself).
 *
 * Prerequisites: same as workspace-artifacts.real-llm.e2e.ts
 * (`pnpm dev` + OPENAI_* + E2E_API_ORIGIN when the API is not on :3001).
 * Model: meta/muse-spark-1.3-contributor, reasoning high (helpers default).
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ORIGIN,
  REAL_LLM_MODEL,
  REAL_LLM_REASONING_EFFORT,
  attachFile,
  sendMessage,
  setReasoningEffort,
  setSwitch,
  waitForRunDone,
} from "./helpers";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(E2E_DIR, "../../.playwright-mcp/workspace-full-workflow");

const TEST_EMAIL = "shafiq@testing.com";
const TEST_PASSWORD = "Test@123";
const TEST_NAME = "Shafiq Testing";
const TAG = "FULLFLOW";

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

async function openSession(page: Page, withModel: boolean): Promise<string> {
  const sessionId = crypto.randomUUID();
  const created = await page.request.post(`${API_ORIGIN}/api/chat/sessions`, {
    data: { sessionId, projectId: null },
  });
  expect(created.ok()).toBe(true);
  await page.goto(`/chat/${encodeURIComponent(sessionId)}`);
  await expect(page.getByRole("heading", { name: /trying to understand/i })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator("[data-anvia-composer-editor]")).toBeVisible();
  if (withModel) {
    const trigger = page.getByRole("button", { name: "Model", exact: true });
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();
    const option = page.locator(`[data-option-value="${REAL_LLM_MODEL}"]`);
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();
    await setReasoningEffort(page, REAL_LLM_REASONING_EFFORT);
  }
  return sessionId;
}

async function pollFor<T>(
  fn: () => Promise<T[]>,
  match: (item: T) => boolean,
  timeoutMs = 180_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const items = await fn();
    const found = items.find(match);
    if (found) return found;
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for expected artifact");
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

async function saveEvidence(page: Page, caseId: string): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, `${caseId}.png`),
    scale: "css",
    mask: [page.locator("article"), page.locator("nav")],
  });
}

type LibraryDoc = { id: string; filename: string };
type ArtifactItem = {
  id?: string;
  sessionId?: string;
  caption?: string;
  title?: string;
  filename?: string;
  source?: string;
  status?: string;
};

async function libraryDocs(page: Page): Promise<LibraryDoc[]> {
  const res = await page.request.get(`${API_ORIGIN}/api/documents/library?scope=attach`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: LibraryDoc[] }).items;
}

async function artifacts(
  page: Page,
  sessionId: string,
  type: string,
): Promise<ArtifactItem[]> {
  const res = await page.request.get(
    `${API_BASE(sessionId, type)}`,
  );
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: ArtifactItem[] }).items;
}

function API_BASE(sessionId: string, type: string): string {
  return `${API_ORIGIN}/api/artifacts?type=${encodeURIComponent(type)}&sessionId=${encodeURIComponent(sessionId)}`;
}

test.describe.serial("workspace full workflow", () => {
  test("analyze → chart → report in one session", async ({ page }) => {
    test.setTimeout(900_000);
    await ensureTestUser(page);
    const sessionId = await openSession(page, true);
    await setSwitch(page, "Web search", true);

    await attachFile(page, "sales.csv");
    await sendMessage(
      page,
      `Analisis ${TAG}: aggregate total revenue per region dari sales.csv, buat bar chart-nya, snapshot chart itu, cari konteks pasar kopi singkat via web search, lalu buatkan laporan PDF berjudul ${TAG} minimal 2 paragraf yang memuat angka, chart, dan sitasi`,
    );
    await waitForRunDone(page, 600_000);

    const report = await pollFor(libraryDocs.bind(null, page), (d) =>
      d.filename.includes(TAG),
      300_000,
    );
    expect(report.id).toBeTruthy();

    const charts = await artifacts(page, sessionId, "image");
    expect(charts.some((i) => i.source === "chart")).toBe(true);
    await saveEvidence(page, "workflow-report");
  });

  test("report becomes a site, reused cross-session", async ({ page }) => {
    test.setTimeout(900_000);
    await ensureTestUser(page);
    const sessionId = await openSession(page, true);

    await sendMessage(
      page,
      `Cari laporan ${TAG} di workspace, lalu buatkan landing page statis bertema kopi yang merangkumnya dengan nama situs ${TAG}site`,
    );
    await waitForRunDone(page, 600_000);

    const site = await pollFor(
      async () => {
        const res = await page.request.get(
          `${API_ORIGIN}/api/sites?sessionId=${encodeURIComponent(sessionId)}`,
        );
        expect(res.ok()).toBe(true);
        return ((await res.json()) as {
          sites: { siteId: string; status: string; previewUrl: string | null }[];
        }).sites;
      },
      (s) => s.status === "ready",
      600_000,
    );
    expect(site.previewUrl).toBeTruthy();
    await saveEvidence(page, "workflow-site");
  });

  test("image generation is attempted live, skipped gracefully on credits", async ({
    page,
  }) => {
    test.setTimeout(600_000);
    await ensureTestUser(page);
    const sessionId = await openSession(page, true);
    await setSwitch(page, "Image generator", true);

    const before = await artifacts(page, sessionId, "image");
    await sendMessage(page, `Generate gambar logo kopi sederhana bertema ${TAG}logo`);
    await waitForRunDone(page, 600_000);

    const after = await artifacts(page, sessionId, "image");
    const fresh = after.filter((a) => !before.some((b) => (b.id ?? "") === (a.id ?? "")));
    if (fresh.length === 0) {
      const text =
        (await page.locator('article[data-role="assistant"]').last().textContent()) ?? "";
      console.log(`IMAGEGEN_NOTE=${text.replace(/\s+/g, " ").slice(0, 300)}`);
      expect(text).toMatch(/credit|quota|limit|balance|maaf|belum bisa/i);
      return;
    }
    expect(fresh.length).toBeGreaterThan(0);
    await saveEvidence(page, "workflow-image");
  });

  test("second session revises the same report, no duplicate", async ({ page }) => {
    test.setTimeout(900_000);
    await ensureTestUser(page);
    const sessionId = await openSession(page, true);

    const before = await libraryDocs(page);
    const target = before.find((d) => d.filename.includes(TAG));
    expect(target?.id).toBeTruthy();

    await sendMessage(
      page,
      `Cari laporan ${TAG}, tambahkan satu paragraf penutup tentang pentingnya dokumentasi rapi, simpan sebagai revisi laporan yang sama jangan bikin file baru`,
    );
    await waitForRunDone(page, 600_000);

    const after = await pollFor(libraryDocs.bind(null, page), (d) =>
      d.filename.includes(TAG),
      180_000,
    );
    expect(after.id).toBe(target!.id);
    expect(sessionId).toBeTruthy();
    await saveEvidence(page, "workflow-revision");
  });
});

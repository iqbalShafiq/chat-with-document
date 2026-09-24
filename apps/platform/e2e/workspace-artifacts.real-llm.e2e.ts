/**
 * Workspace Artifacts acceptance with the real stack and real LLM.
 * Spec: docs/superpowers/specs/2026-09-24-workspace-artifacts-design.md
 * Plan: docs/superpowers/plans/2026-09-24-workspace-artifacts.md
 * Prerequisites:
 *   - `pnpm dev` running (API :3001, platform :3000, worker) with
 *     OPENAI_BASE_URL=https://openrouter.ai/api/v1 and a real OPENAI_API_KEY.
 *   - Run: `pnpm --filter @anreal/platform exec playwright test --config playwright.real-llm.config.ts e2e/workspace-artifacts.real-llm.e2e.ts`
 * Signs in as shafiq@testing.com (registers first when missing).
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
  sendMessage,
  setReasoningEffort,
  uploadAndAsk,
  waitForRunDone,
} from "./helpers";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(E2E_DIR, "../../.playwright-mcp/workspace-artifacts");

const TEST_EMAIL = "shafiq@testing.com";
const TEST_PASSWORD = "Test@123";
const TEST_NAME = "Shafiq Testing";

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

async function openFreshChatExact(page: Page): Promise<string> {
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
  return sessionId;
}

async function openFreshChatWithModel(page: Page): Promise<string> {
  const sessionId = await openFreshChatExact(page);
  const trigger = page.getByRole("button", { name: "Model", exact: true });
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
  const option = page.locator(`[data-option-value="${REAL_LLM_MODEL}"]`);
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
  await setReasoningEffort(page, REAL_LLM_REASONING_EFFORT);
  return sessionId;
}

async function pollFor<T>(
  fn: () => Promise<T[]>,
  match: (item: T) => boolean,
  timeoutMs = 120_000,
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

test.describe.serial("workspace artifacts", () => {
  test("agent plans a family trip with subtasks", async ({ page }) => {
    test.setTimeout(900_000);
    await ensureTestUser(page);
    const sessionId = await openFreshChatWithModel(page);
    const stamp = new Date().toISOString().slice(5, 10);
    const title = `Rencana liburan keluarga ke Bandung (${stamp})`;

    await sendMessage(
      page,
      `Tolong buatkan daftar rencana "${title}" dengan subtask: booking hotel, beli tiket kereta, dan susun itinerary 2 hari`,
    );
    await waitForRunDone(page);

    type TaskRow = {
      id: string;
      title: string;
      status: string;
      subtasks: { id: string; title: string; done: boolean }[];
    };
    const listTasks = async (): Promise<TaskRow[]> => {
      const res = await page.request.get(
        `${API_ORIGIN}/api/tasks?sessionId=${encodeURIComponent(sessionId)}`,
      );
      expect(res.ok()).toBe(true);
      return ((await res.json()) as { items: TaskRow[] }).items;
    };
    const task = await pollFor(listTasks, (t) => t.title === title);
    expect(task.status).toBe("inbox");
    expect(task.subtasks.length).toBeGreaterThanOrEqual(3);

    await sendMessage(page, "Hotelnya sudah saya booking, tandai subtask booking hotel sebagai selesai");
    await waitForRunDone(page);

    const updated = await pollFor(
      listTasks,
      (t) => t.id === task.id && t.subtasks.some((s) => s.done),
    );
    expect(updated.subtasks.filter((s) => s.done)).toHaveLength(1);

    await sendMessage(page, "Semuanya beres, tandai rencana liburannya selesai");
    await waitForRunDone(page);

    const done = await pollFor(
      listTasks,
      (t) => t.id === task.id && t.status === "done",
    );
    expect(done.status).toBe("done");
    await saveEvidence(page, "task-subtasks");
  });

  test("agent builds a PDF report from chat content", async ({ page }) => {
    test.setTimeout(900_000);
    await ensureTestUser(page);
    const sessionId = await openFreshChatWithModel(page);

    const beforeRes = await page.request.get(`${API_ORIGIN}/api/documents/library?scope=attach`);
    expect(beforeRes.ok()).toBe(true);
    const beforeIds = new Set(
      ((await beforeRes.json()) as { items: { id: string }[] }).items.map((d) => d.id),
    );

    await sendMessage(
      page,
      "Buatkan laporan PDF tentang tiga keuntungan dokumentasi yang rapi untuk tim operasional",
    );
    await waitForRunDone(page);

    const docs = await pollFor(
      async () => {
        const res = await page.request.get(
          `${API_ORIGIN}/api/documents/library?scope=attach`,
        );
        expect(res.ok()).toBe(true);
        return ((await res.json()) as { items: { id: string; filename: string }[] }).items;
      },
      (d) => !beforeIds.has(d.id) && d.filename.toLowerCase().includes("dokumentasi"),
      240_000,
    );
    expect(docs.id).toBeTruthy();
    expect(sessionId).toBeTruthy();
    await saveEvidence(page, "report-created");
  });

  test("agent charts sales data and embeds it in a PDF report", async ({ page }) => {
    test.setTimeout(900_000);
    await ensureTestUser(page);
    const stamp = new Date().toISOString().slice(5, 16).replace(/[:T]/g, "-");
    const reportTag = `analisis-penjualan-${stamp}`;

    // Watch-mode dev restarts can drop one upload/send; retry once on a
    // guaranteed-fresh session (no queue pollution from the first attempt).
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await openFreshChatWithModel(page);
      try {
        await uploadAndAsk(
          page,
          "sales.csv",
          `Analisis penjualan per region, buat bar chart-nya, snapshot chart itu, lalu buatkan laporan PDF berjudul ${reportTag} yang memuat chart tersebut`,
        );
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;

    const docs = await pollFor(
      async () => {
        const res = await page.request.get(`${API_ORIGIN}/api/documents/library?scope=attach`);
        expect(res.ok()).toBe(true);
        return ((await res.json()) as { items: { id: string; filename: string }[] }).items;
      },
      (d) => d.filename.includes(reportTag),
      420_000,
    );
    expect(docs.id).toBeTruthy();

    const charts = await page.request.get(`${API_ORIGIN}/api/artifacts?type=image`);
    expect(charts.ok()).toBe(true);
    const chartBody = (await charts.json()) as {
      items: { id: string; caption?: string; source?: string }[];
    };
    expect(chartBody.items.some((i) => i.source === "chart")).toBe(true);
    await saveEvidence(page, "chart-report-created");
  });

  test("standalone scope excludes project artifacts", async ({ page }) => {
    await ensureTestUser(page);
    const sessionId = await openFreshChatExact(page);

    const res = await page.request.get(
      `${API_ORIGIN}/api/artifacts?type=task&sessionId=${encodeURIComponent(sessionId)}`,
    );
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { items: { projectId: string | null }[] };
    expect(body.items.every((i) => i.projectId === null)).toBe(true);
  });

  test("image caption search finds a generated asset", async ({ page }) => {
    await ensureTestUser(page);
    await openFreshChatExact(page);

    const res = await page.request.get(`${API_ORIGIN}/api/artifacts?type=image`);
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as {
      items: { id: string; caption?: string; prompt?: string }[];
    };
    expect(Array.isArray(body.items)).toBe(true);
    for (const item of body.items) {
      expect((item.caption ?? item.prompt ?? "").length).toBeGreaterThan(0);
    }
  });
});

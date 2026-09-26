/**
 * Schedule execution acceptance with the real stack and a real LLM run.
 * Spec: docs/superpowers/specs/2026-09-24-workspace-artifacts-design.md §4.5
 * Prerequisites: `pnpm dev` running (API + worker + platform), OPENAI_* set,
 * E2E_API_ORIGIN=http://localhost:4312.
 * The schedule fires the stored prompt in its origin session via the normal
 * chat-run pipeline (default model) — the follow-up message IS the notification.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { API_ORIGIN } from "./helpers";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(E2E_DIR, "../../.playwright-mcp/site-viewing");

const TEST_EMAIL = "shafiq@testing.com";
const TEST_PASSWORD = "Test@123";
const TEST_NAME = "Shafiq Testing";
const MARKER = "SCHEDULE-OK";

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

test.describe.serial("workspace schedule execution", () => {
  test("a due schedule runs its prompt and posts the follow-up", async ({ page }) => {
    test.setTimeout(900_000);
    await ensureTestUser(page);

    const sessionId = crypto.randomUUID();
    const created = await page.request.post(`${API_ORIGIN}/api/chat/sessions`, {
      data: { sessionId, projectId: null },
    });
    expect(created.ok()).toBe(true);

    const schedule = await page.request.post(`${API_ORIGIN}/api/schedules`, {
      data: {
        sessionId,
        title: `e2e-${Date.now().toString(36)}`,
        prompt: `Balas tepat dengan teks ${MARKER} tanpa penjelasan lain.`,
        freq: "once",
        runAt: new Date(Date.now() + 15_000).toISOString(),
      },
    });
    expect(schedule.ok()).toBe(true);
    const scheduleRow = (await schedule.json()) as { id: string };

    // The run lands in the origin session as an assistant follow-up.
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            `${API_ORIGIN}/api/chat?sessionId=${encodeURIComponent(sessionId)}`,
          );
          if (!response.ok()) return "";
          const messages = (await response.json()) as Array<{
            role: string;
            content?: Array<{ type?: string; text?: string }>;
          }>;
          return messages
            .filter((message) => message.role === "assistant")
            .flatMap((message) => message.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n");
        },
        { timeout: 600_000, intervals: [5_000] },
      )
      .toContain(MARKER);

    // Once-scheduled work is marked done.
    const list = await page.request.get(
      `${API_ORIGIN}/api/schedules?sessionId=${encodeURIComponent(sessionId)}`,
    );
    expect(list.ok()).toBe(true);
    const rows = ((await list.json()) as { items: Array<{ id: string; status: string }> }).items;
    const finished = rows.find((row) => row.id === scheduleRow.id);
    expect(finished?.status).toBe("done");

    await page.goto(`/chat/${encodeURIComponent(sessionId)}`);
    await expect(page.locator('article[data-role="assistant"]').last()).toContainText(MARKER, {
      timeout: 30_000,
    });
    await mkdir(EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: resolve(EVIDENCE_DIR, "schedule-execution.png") });
  });
});

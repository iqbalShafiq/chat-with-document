/**
 * Anvia v1 cutover acceptance against the real local stack and real DeepSeek.
 * This file is intentionally excluded from the deterministic/stub config.
 */
import { expect, test, type Page, type Request } from "@playwright/test";
import { parseClientStreamFrame } from "@anvia/client";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  API_ORIGIN,
  openFreshChat,
  sendMessage,
  waitForIdleComposer,
  waitForRunDone,
  waitForStreaming,
} from "./helpers";
import { restartChatWorker } from "./restart-chat-worker";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(E2E_DIR, "../../../.playwright-mcp/anvia-v1");
const CHAT_ENDPOINT = `${API_ORIGIN}/api/chat`;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function saveEvidence(page: Page, caseId: string, data: JsonRecord = {}) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({
    path: resolve(EVIDENCE_DIR, `${caseId}.png`),
    scale: "css",
    mask: [page.locator("article"), page.locator("nav")],
  });
  await writeFile(
    resolve(EVIDENCE_DIR, `${caseId}.snapshot.yml`),
    `# Redacted evidence: prompts, outputs, reasoning, and tool arguments are intentionally omitted.\ncase: ${caseId}\n`,
    "utf8",
  );
  await writeFile(
    resolve(EVIDENCE_DIR, `${caseId}.json`),
    `${JSON.stringify({ url: page.url(), ...data }, null, 2)}\n`,
    "utf8",
  );
}

function captureInteractionResponses(page: Page): JsonRecord[] {
  const bodies: JsonRecord[] = [];
  page.on("request", (request: Request) => {
    if (request.method() !== "POST" || request.url() !== CHAT_ENDPOINT) return;
    const body: unknown = request.postDataJSON();
    if (isRecord(body) && body.type === "interaction_response") bodies.push(body);
  });
  return bodies;
}

function parseNdjson(text: string): JsonRecord[] {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRecord);
}

function assertMonotonicEventIds(frames: JsonRecord[], label: string): number[] {
  const eventIds = frames.map((frame) => frame.eventId);
  expect(eventIds.every((id) => Number.isInteger(id)), `${label} event ids`).toBe(true);
  const ids = eventIds as number[];
  const comparable = frames.at(-1)?.type === "stream_end" ? ids.slice(0, -1) : ids;
  for (let index = 1; index < comparable.length; index += 1) {
    expect(
      comparable[index],
      `${label} event ids must be strictly increasing`,
    ).toBeGreaterThan(comparable[index - 1]!);
  }
  expect(new Set(comparable).size, `${label} must not duplicate event ids`).toBe(
    comparable.length,
  );
  return ids;
}

function assertProtocolFrames(
  frames: JsonRecord[],
  label: string,
  options: { requireTerminal?: boolean } = {},
): void {
  const requireTerminal = options.requireTerminal ?? true;
  expect(frames.length, `${label} must contain JSONL frames`).toBeGreaterThan(1);
  expect(frames[0], `${label} must start with stream_start`).toMatchObject({
    type: "stream_start",
    protocol: "anvia.client.v3",
    eventId: 0,
    resumable: true,
  });
  const ids = assertMonotonicEventIds(frames, label);
  const terminal = frames.filter((frame) => frame.type === "stream_end");
  if (requireTerminal) {
    expect(terminal, `${label} must emit exactly one terminal frame`).toHaveLength(1);
    expect(frames.at(-1), `${label} must end with the terminal frame`).toMatchObject({
      type: "stream_end",
    });
    expect(ids.at(-1), `${label} terminal reuses the last event id`).toBe(ids.at(-2));
  } else {
    expect(terminal.length, `${label} must not emit more than one terminal`).toBeLessThanOrEqual(1);
  }
  for (const frame of frames) {
    expect(() => parseClientStreamFrame(frame)).not.toThrow();
  }
}

function captureCompletedChatStreams(page: Page): Promise<JsonRecord[]>[] {
  const streams: Promise<JsonRecord[]>[] = [];
  page.on("requestfinished", (request: Request) => {
    if (request.method() !== "POST" || request.url() !== CHAT_ENDPOINT) return;
    streams.push(
      request.response().then(async (response) => {
        if (!response) return [];
        const contentType = response.headers()["content-type"] ?? "";
        if (!contentType.includes("application/x-ndjson")) return [];
        return parseNdjson(await response.text());
      }),
    );
  });
  return streams;
}

function captureChatResumeCursors(page: Page): Array<{ streamId: string; after: number }> {
  const cursors: Array<{ streamId: string; after: number }> = [];
  page.on("request", (request: Request) => {
    if (request.method() !== "POST" || request.url() !== CHAT_ENDPOINT) return;
    const body: unknown = request.postDataJSON();
    if (!isRecord(body) || !isRecord(body.resume)) return;
    const streamId = body.resume.streamId;
    const after = body.resume.after;
    if (typeof streamId === "string" && Number.isInteger(after)) {
      cursors.push({ streamId, after: after as number });
    }
  });
  return cursors;
}

test("v3 stream exposes its protocol and resumes exactly once after reload", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const protocols: Array<string | undefined> = [];
  const streams = captureCompletedChatStreams(page);
  const resumeCursors = captureChatResumeCursors(page);
  const capturedRequest: { current: JsonRecord | null } = { current: null };
  page.on("request", (request: Request) => {
    if (request.method() !== "POST" || request.url() !== CHAT_ENDPOINT) return;
    const body: unknown = request.postDataJSON();
    if (isRecord(body) && body.type === "messages" && !isRecord(body.resume)) {
      capturedRequest.current = body;
    }
  });
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || response.url() !== CHAT_ENDPOINT) {
      return;
    }
    protocols.push((await response.allHeaders())["x-anvia-stream-protocol"]);
  });

  await openFreshChat(page);
  const prompt =
    "Write 30 short numbered facts about HTTP streaming. End with the exact token ANVIA_V1_RESUME_OK.";
  await sendMessage(page, prompt);
  await waitForStreaming(page);
  // `submitted` also exposes the queue control. Reload only after the first
  // assistant stream event proves stream_start was accepted and persisted in
  // Anvia's v3 resume storage.
  await expect(page.locator('article[data-role="assistant"]').first()).toBeVisible({
    timeout: 120_000,
  });
  const activeSessionId = await page.evaluate(() =>
    window.localStorage.getItem("chat.sessionId"),
  );
  const nextDraft = await page.request.post(
    `${API_ORIGIN}/api/chat/sessions/draft`,
    { data: { projectId: null } },
  );
  expect(nextDraft.ok()).toBe(true);
  expect((await nextDraft.json()) as { sessionId: string }).not.toMatchObject({
    sessionId: activeSessionId,
  });
  const resumeKeys = () =>
    page.evaluate(() =>
      Object.keys(window.sessionStorage).filter((key) =>
        key.startsWith("anvia:chat-resume:"),
      ),
    );
  await expect.poll(async () => (await resumeKeys()).length).toBe(1);
  const [resumeKey] = await resumeKeys();
  expect(resumeKey).toBeTruthy();
  const resumeState = await page.evaluate((key) => {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as unknown);
  }, resumeKey!);
  expect(resumeState).toMatchObject({
    version: 3,
    request: { type: "messages" },
  });
  await page.reload();
  await expect(page.getByText(prompt, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("ANVIA_V1_RESUME_OK", { exact: true })).toBeVisible({
    timeout: 240_000,
  });
  await waitForRunDone(page, 30_000);

  expect(protocols.length).toBeGreaterThanOrEqual(1);
  expect(protocols.every((protocol) => protocol === "anvia.client.v3")).toBe(true);
  const reloadCursor = resumeCursors.find((cursor) => cursor.after > 0);
  expect(reloadCursor).toBeTruthy();
  const capturedStreams = (await Promise.all(streams)).filter((frames) => frames.length > 0);
  const resumed = capturedStreams.find((frames) =>
    frames.some((frame) => frame.type === "stream_end"),
  );
  expect(resumed).toBeTruthy();
  assertProtocolFrames(resumed!, "resumed stream");
  const firstResumedEvent = resumed!.find(
    (frame) => frame.type !== "stream_start" && frame.type !== "stream_end",
  );
  expect(firstResumedEvent).toBeTruthy();
  expect(firstResumedEvent!.eventId as number).toBeGreaterThan(reloadCursor!.after);
  const requestBody = capturedRequest.current;
  if (requestBody === null || reloadCursor === undefined) {
    throw new Error("missing original chat request or resume cursor");
  }
  const replayPayload: JsonRecord = {
    type: requestBody.type,
    messages: requestBody.messages,
    metadata: requestBody.metadata,
    resume: { streamId: reloadCursor.streamId, after: 0 },
  };
  const replay = await page.request.post(CHAT_ENDPOINT, {
    data: replayPayload,
  });
  expect(replay.ok()).toBe(true);
  const stored = parseNdjson(await replay.text());
  assertProtocolFrames(stored, "stored stream replay");
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
  await saveEvidence(page, "protocol-reload-resume", {
    protocols,
    resumeAfter: reloadCursor!.after,
    resumedFrameCount: resumed!.length,
    storedFrameCount: stored.length,
  });
});

test("stop preserves the prompt and native regenerate completes a fresh run", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openFreshChat(page);
  const prompt =
    "Write 30 short numbered facts about TypeScript. End with the exact token ANVIA_V1_REGENERATE_OK.";
  await sendMessage(page, prompt);
  await waitForStreaming(page);
  await expect
    .poll(
      async () =>
        (await page.locator('article[data-role="assistant"]').last().innerText().catch(() => ""))
          .trim().length,
      { timeout: 120_000 },
    )
    .toBeGreaterThan(20);
  await page.getByRole("button", { name: "Stop" }).click();
  await waitForRunDone(page, 60_000);
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);

  await page.getByRole("button", { name: "Regenerate from this message" }).click();
  await page.getByRole("button", { name: "Regenerate", exact: true }).click();
  await waitForStreaming(page);
  await waitForRunDone(page, 240_000);
  await expect(
    page.getByText("ANVIA_V1_REGENERATE_OK", { exact: true }).last(),
  ).toBeVisible();
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
  await saveEvidence(page, "stop-regenerate");
});

test("native question survives reload and rejects replay and wrong-session responses", async ({
  page,
}) => {
  test.setTimeout(300_000);
  const interactionBodies = captureInteractionResponses(page);
  await openFreshChat(page);
  await sendMessage(
    page,
    "Before answering, call request_clarification exactly once. Ask one required free-text question with id migration_goal and text 'What migration goal should I use?'. After the answer, reply with exactly QUESTION_RESUME_OK.",
  );
  const question = page.getByRole("region", { name: "Question" });
  await expect(question).toBeVisible({ timeout: 120_000 });
  await page.reload();
  await expect(question).toBeVisible({ timeout: 60_000 });
  await question
    .getByRole("textbox", { name: "What migration goal should I use?" })
    .fill("Full Anvia v1 migration");
  await question.getByRole("button", { name: "Submit" }).click();
  await waitForRunDone(page, 180_000);
  await expect(page.getByText("QUESTION_RESUME_OK", { exact: true })).toBeVisible();

  expect(interactionBodies).toHaveLength(1);
  const acceptedBody = interactionBodies[0]!;
  const replay = await page.request.post(CHAT_ENDPOINT, { data: acceptedBody });
  expect(replay.status()).toBe(409);
  expect(await replay.json()).toMatchObject({ code: "INTERACTION_REPLAYED" });

  const draft = await page.request.post(`${API_ORIGIN}/api/chat/sessions/draft`, {
    data: { projectId: null },
  });
  expect(draft.ok()).toBe(true);
  const draftBody: unknown = await draft.json();
  expect(isRecord(draftBody) && typeof draftBody.sessionId === "string").toBe(true);
  const metadata = acceptedBody.metadata;
  expect(isRecord(metadata)).toBe(true);
  const wrongSessionBody = {
    ...acceptedBody,
    metadata: { ...(metadata as JsonRecord), sessionId: (draftBody as JsonRecord).sessionId },
  };
  const wrongSession = await page.request.post(CHAT_ENDPOINT, {
    data: wrongSessionBody,
  });
  expect(wrongSession.status()).toBe(404);
  expect(await wrongSession.json()).toMatchObject({ code: "INTERACTION_NOT_FOUND" });
  await saveEvidence(page, "question-reload-replay", {
    replayStatus: replay.status(),
    wrongSessionStatus: wrongSession.status(),
  });
});

test("multiple follow-ups remain editable and are acknowledged through the native queue", async ({
  page,
}) => {
  test.setTimeout(360_000);
  await openFreshChat(page);
  await sendMessage(
    page,
    "Write 12 short numbered facts about HTTP, one line each. End with the exact token BASE_QUEUE_OK.",
  );
  await waitForStreaming(page);

  await sendMessage(page, "After that, reply with exactly FIRST_QUEUE_OK.");
  await sendMessage(page, "Then reply with exactly SECOND_QUEUE_OK.");
  const queue = page.getByRole("list", { name: "Queued messages" });
  await expect(queue).toBeVisible();
  await expect(queue).toContainText("FIRST_QUEUE_OK");
  await expect(queue.getByText(/load more \(1\)/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Stop|Add to queue)$/ })).toBeVisible();
  await page.getByRole("button", { name: "Expand queue" }).click();
  await expect(queue).toContainText("SECOND_QUEUE_OK");
  const items = queue.getByRole("listitem");
  await expect(items).toHaveCount(2, { timeout: 5_000 });
  await items.first().getByTitle("Click to edit").click();
  const editor = page.locator("[data-anvia-composer-editor]");
  await expect(editor).toContainText("FIRST_QUEUE_OK");
  await editor.press("End");
  await editor.pressSequentially(" EDITED");
  await page.getByRole("button", { name: "Add to queue" }).click();
  await expect(queue).toContainText("FIRST_QUEUE_OK. EDITED");
  const reorderedItems = queue.getByRole("listitem");
  await reorderedItems.nth(1).dragTo(reorderedItems.nth(0));
  await expect(reorderedItems.first()).toContainText("SECOND_QUEUE_OK");
  await waitForIdleComposer(page, 300_000);
  await expect(page.getByText("Then reply with exactly SECOND_QUEUE_OK.")).toBeVisible();
  await expect(page.getByText(/FIRST_QUEUE_OK\. EDITED/)).toBeVisible();
  const order = await page.evaluate(() => {
    const articles = [...document.querySelectorAll("article")].map(
      (element) => element.textContent ?? "",
    );
    return {
      second: articles.findIndex((text) =>
        text.includes("Then reply with exactly SECOND_QUEUE_OK."),
      ),
      edited: articles.findIndex((text) => text.includes("FIRST_QUEUE_OK. EDITED")),
    };
  });
  expect(order.second).toBeGreaterThan(-1);
  expect(order.edited).toBeGreaterThan(order.second);
  await saveEvidence(page, "native-queue");
});

test("required-choice question survives an actual chat-worker restart", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openFreshChat(page);
  await sendMessage(
    page,
    "Before answering, call request_clarification exactly once. Ask one required single-choice question with id migration_style, text 'Which migration style should I use?', and choices cutover and strangler. Do not allow custom text. After the answer, reply with exactly CHOICE_RESTART_OK.",
  );
  const question = page.getByRole("region", { name: "Question" });
  await expect(question).toBeVisible({ timeout: 120_000 });
  const restart = await restartChatWorker();
  expect(restart.nextPid).not.toBe(restart.previousPid);
  await expect(question).toBeVisible();
  await question.getByRole("radio", { name: /cutover/i }).click();
  await question.getByRole("button", { name: "Submit" }).click();
  await waitForRunDone(page, 180_000);
  await expect(page.getByText("CHOICE_RESTART_OK", { exact: true })).toBeVisible();
  await saveEvidence(page, "question-worker-restart", {
    previousPid: restart.previousPid,
    nextPid: restart.nextPid,
  });
});

test("web-search approval survives an actual chat-worker restart", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await openFreshChat(page);
  await sendMessage(
    page,
    "Call web_search exactly once for the official Anvia 1.0.1 release announcement. Do not ask a clarification question. After the tool returns, reply with exactly APPROVAL_RESTART_OK.",
  );
  const approval = page.getByRole("region", { name: /approve searching the web/i });
  await expect(approval).toBeVisible({ timeout: 120_000 });
  const restart = await restartChatWorker();
  expect(restart.nextPid).not.toBe(restart.previousPid);
  await expect(approval).toBeVisible();
  await approval.getByRole("button", { name: "Allow once" }).click();
  await waitForRunDone(page, 180_000);
  await expect(page.getByText("APPROVAL_RESTART_OK", { exact: true })).toBeVisible();
  await saveEvidence(page, "approval-worker-restart", {
    previousPid: restart.previousPid,
    nextPid: restart.nextPid,
  });
});


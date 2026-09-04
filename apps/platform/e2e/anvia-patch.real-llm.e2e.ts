/**
 * Real-LLM regression for the Anvia 1.0.x patch bump.
 * Uses DeepSeek V4 Flash at reasoning effort max — never the local stub.
 */
import { expect, test } from "@playwright/test";
import {
  API_ORIGIN,
  openFreshChat,
  REAL_LLM_MODEL,
  REAL_LLM_REASONING_EFFORT,
  sendMessage,
  waitForRunDone,
  waitForStreaming,
} from "./helpers";

test("pins DeepSeek V4 Flash at max and keeps the v3 stream protocol", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const protocols: string[] = [];
  const captured: { metadata?: { modelId?: string; reasoningEffort?: string } } =
    {};
  page.on("request", (request) => {
    if (request.method() !== "POST" || request.url() !== `${API_ORIGIN}/api/chat`) {
      return;
    }
    const body: unknown = request.postDataJSON();
    if (
      typeof body === "object" &&
      body !== null &&
      "type" in body &&
      body.type === "messages" &&
      "metadata" in body
    ) {
      captured.metadata = (
        body as { metadata?: { modelId?: string; reasoningEffort?: string } }
      ).metadata;
    }
  });
  page.on("response", async (response) => {
    if (response.request().method() !== "POST" || response.url() !== `${API_ORIGIN}/api/chat`) {
      return;
    }
    const protocol = (await response.allHeaders())["x-anvia-stream-protocol"];
    if (protocol) protocols.push(protocol);
  });

  await openFreshChat(page);
  await expect(page.getByRole("button", { name: "Model" }).first()).toContainText(
    /deepseek/i,
  );
  await expect(page.getByRole("button", { name: "Reasoning effort" })).toContainText(
    /max/i,
  );
  await sendMessage(page, "Reply with exactly the token ANVIA_PATCH_OK and nothing else.");
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.getByText("ANVIA_PATCH_OK").last()).toBeVisible({
    timeout: 10_000,
  });
  expect(captured.metadata).toMatchObject({
    modelId: REAL_LLM_MODEL,
    reasoningEffort: REAL_LLM_REASONING_EFFORT,
  });
  expect(protocols.length).toBeGreaterThan(0);
  expect(protocols.every((protocol) => protocol === "anvia.client.v3")).toBe(true);
});

test("stop then delete removes a session that was still running", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await openFreshChat(page);
  const sessionId = await page.evaluate(() => window.localStorage.getItem("chat.sessionId"));
  expect(sessionId).toBeTruthy();

  await sendMessage(
    page,
    "Write 40 short numbered facts about TypeScript, one sentence each. Do not stop early.",
  );
  await waitForStreaming(page);
  await page.getByRole("button", { name: "Stop" }).click();
  await waitForRunDone(page, 60_000);

  const actions = page.getByRole("button", { name: /Chat actions for / });
  await expect(actions.first()).toBeVisible();
  await actions.first().click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete chat" }).click();

  await expect
    .poll(async () => {
      const response = await page.request.get(`${API_ORIGIN}/api/chat/sessions`);
      if (!response.ok()) return "list-failed";
      const body = (await response.json()) as {
        items?: Array<{ sessionId?: string }>;
      };
      return body.items?.some((session) => session.sessionId === sessionId)
        ? "present"
        : "gone";
    })
    .toBe("gone");
});

test("replayed history still shows original user prompts", async ({ page }) => {
  test.setTimeout(240_000);
  await openFreshChat(page);
  const first = "Remember the project name ANVIA_PATCH_HISTORY.";
  await sendMessage(page, first);
  await waitForStreaming(page);
  await waitForRunDone(page);
  await sendMessage(page, "Reply with exactly HISTORY_TURN_TWO.");
  await waitForStreaming(page);
  await waitForRunDone(page);
  await expect(page.getByText(first, { exact: true })).toBeVisible();
  await expect(page.getByText("HISTORY_TURN_TWO").last()).toBeVisible();
  await page.reload();
  await expect(page.getByText(first, { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText("HISTORY_TURN_TWO").last()).toBeVisible();
});

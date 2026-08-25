// @vitest-environment jsdom
import { createRef } from "react";
import type { UIAttachment } from "@anvia/client";
import {
  ChatProvider,
  ComposerPrimitive,
  type ChatController,
  type ComposerSubmitMessageArgs,
} from "@anvia/react-ui";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/components/chat/context-snippet-chip", () => ({ ContextSnippetChip: () => null }));
vi.mock("#/components/composer/composer-attach-control", () => ({ ComposerAttachControl: () => null }));
vi.mock("#/components/composer/context-usage-indicator", () => ({ ContextUsageIndicator: () => null }));
vi.mock("#/components/composer/features-popover", () => ({ FeaturesPopover: () => null }));
vi.mock("#/components/composer/message-queue-dock", () => ({ MessageQueueDock: () => null }));
vi.mock("#/components/composer/model-reasoning-switcher", () => ({ ModelReasoningSwitcher: () => null }));
vi.mock("#/components/images/generated-image-thumbnail", () => ({ GeneratedImageThumbnail: () => null }));
vi.mock("#/lib/api", () => ({ isImageAttachmentLike: () => false }));

import { ChatComposer } from "./chat-composer";

afterEach(cleanup);

const model = {
  modelId: "deepseek/deepseek-v4-flash-0731",
  label: "DeepSeek V4 Flash",
  name: "DeepSeek V4 Flash",
  hint: null,
  description: null,
  iconSvg: "",
  provider: { slug: "deepseek", name: "DeepSeek" },
  contextWindowTokens: 128_000,
  maxInputTokens: null,
  maxOutputTokens: null,
  prices: { input: null, cachedInput: null, output: null, cacheWriteMultiplier: null, longPromptThresholdTokens: null, longPromptInputMultiplier: null, longPromptOutputMultiplier: null },
  reasoningEfforts: ["max"],
  outputType: "text" as const,
  imageCapabilities: null,
  inputModalities: ["text"],
  sortOrder: 0,
};

function controller(
  status: ChatController["status"],
  stop: () => void = vi.fn(),
): ChatController {
  return {
    messages: [],
    events: [],
    contextUsage: undefined,
    suggestions: [],
    setMessages: vi.fn(),
    sendMessage: vi.fn(async () => undefined),
    regenerate: vi.fn(async () => undefined),
    stop,
    reset: vi.fn(),
    status,
    error: undefined,
    text: "",
    streamId: status === "submitted" || status === "streaming" ? "stream-1" : undefined,
    isResuming: false,
    resume: vi.fn(async () => undefined),
    interactions: { all: [], pending: [] },
    respondingInteractions: new Set<string>(),
    respondToInteraction: vi.fn(async () => undefined),
  };
}

function renderComposer(input: {
  status: ChatController["status"];
  onQueueSubmit?: (text: string, attachments: UIAttachment[]) => Promise<void> | void;
  onStopRun?: () => void;
  primitiveStop?: () => void;
  defaultAttachments?: UIAttachment[];
  composerError?: string | null;
}) {
  const chat = controller(input.status, input.primitiveStop);
  const submitMessage = vi.fn(async (_args: ComposerSubmitMessageArgs) => undefined);
  render(
    <ChatProvider controller={chat}>
      <ComposerPrimitive.Root
        attachments={input.defaultAttachments}
        submitMessage={submitMessage}
      >
        <ChatComposer
          sessionId="session-1"
          chatStatus={input.status}
          isIngesting={false}
          composerError={input.composerError ?? null}
          attachmentErrors={[]}
          composerInputRef={createRef<HTMLTextAreaElement>()}
          model={model.modelId}
          reasoningEffort="max"
          onModelChange={() => undefined}
          onReasoningChange={() => undefined}
          onStopRun={input.onStopRun}
          onQueueSubmit={input.onQueueSubmit}
          onDismissAttachmentError={() => undefined}
          models={[model]}
          modelsStatus="success"
        />
      </ComposerPrimitive.Root>
    </ChatProvider>,
  );
  return { chat, submitMessage };
}

describe("Anvia v1 composer DOM contract", () => {
  it.each(["submitted", "streaming"] as const)(
    "keeps the public textarea editable while %s",
    async (status) => {
      renderComposer({ status, onQueueSubmit: vi.fn() });
      const editor = screen.getByRole<HTMLTextAreaElement>("textbox");
      expect(editor.disabled).toBe(false);
      await userEvent.type(editor, "follow up");
      expect(editor.value).toBe("follow up");
      expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add to queue" }).disabled).toBe(false);
    },
  );

  it("routes Enter plus a rapid click to one queue operation", async () => {
    let resolveQueue!: () => void;
    const pending = new Promise<void>((resolve) => { resolveQueue = resolve; });
    const onQueueSubmit = vi.fn(() => pending);
    renderComposer({ status: "streaming", onQueueSubmit });
    const editor = screen.getByRole("textbox");
    await userEvent.type(editor, "queued follow up");
    fireEvent.keyDown(editor, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    expect(onQueueSubmit).toHaveBeenCalledOnce();
    resolveQueue();
    await pending;
  });

  it("queues attachments through the application boundary", () => {
    const attachment: UIAttachment = { id: "file-1", type: "file", name: "notes.txt", text: "notes" };
    const onQueueSubmit = vi.fn();
    renderComposer({ status: "submitted", defaultAttachments: [attachment], onQueueSubmit });
    fireEvent.click(screen.getByRole("button", { name: "Add to queue" }));
    expect(onQueueSubmit).toHaveBeenCalledWith("", [attachment]);
  });

  it("issues one application stop and suppresses the primitive stop", () => {
    const onStopRun = vi.fn();
    const primitiveStop = vi.fn();
    renderComposer({ status: "streaming", onStopRun, primitiveStop });
    const button = screen.getByRole("button", { name: "Stop" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onStopRun).toHaveBeenCalledOnce();
    expect(primitiveStop).not.toHaveBeenCalled();
  });

  it("disables the editor while waiting", () => {
    renderComposer({ status: "waiting" });
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").disabled).toBe(true);
  });

  it("keeps the editor enabled after an error so the user can recover", () => {
    renderComposer({ status: "error" });
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").disabled).toBe(false);
  });

  it("associates immediate composer errors with an alert", () => {
    renderComposer({ status: "ready", composerError: "Send failed" });
    expect(screen.getByRole("alert").textContent).toContain("Send failed");
  });
});

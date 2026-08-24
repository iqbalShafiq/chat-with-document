// @vitest-environment jsdom

import {
  createDirectClientTransport,
  type ClientDataMap,
  type ClientInteraction,
  type ClientMetadata,
  type ClientStreamEvent,
  type ClientStreamRequest,
  type ClientTransport,
} from "@anvia/client";
import {
  assertAgentInteractionResponse,
  parseAgentInteractionRequest,
  type AgentInteractionRequest,
  type AgentInteractionResponse,
  type AgentToolQuestionRequest,
} from "@anvia/core/agent/interactions";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactNode, useEffect, useRef } from "react";
import { useChat } from "@anvia/react";
import { ChatProvider } from "@anvia/react-ui";
import {
  API_BASE,
  stageInteractionPolicy,
  type ImageModelCatalogItem,
} from "#/lib/api";
import { ApprovalPanel } from "#/components/chat/approval-panel";
import { ClarificationPanel } from "#/components/chat/clarification-panel";
import {
  buildApprovalResponse,
  buildImageOverride,
  buildQuestionResponse,
  stageThenRespond,
} from "./interaction-response";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const approvalRequest = parseAgentInteractionRequest({
  id: "interaction-approval-1",
  type: "tool-approval",
  toolName: "generate_image",
  toolCallId: "tool-call-1",
  internalCallId: "internal-call-1",
  input: { prompt: "a mountain landscape", n: 1 },
  reason: "Image generation needs approval.",
});

const parsedQuestionRequest = parseAgentInteractionRequest({
  id: "interaction-question-1",
  type: "tool-question",
  toolName: "clarify_request",
  toolCallId: "tool-call-2",
  internalCallId: "internal-call-2",
  questions: [
    {
      id: "style",
      text: "Which style should be used?",
      choices: [
        { label: "Minimal", value: "minimal" },
        { label: "Editorial", value: "editorial" },
      ],
    },
    {
      id: "notes",
      text: "Any additional notes?",
      allowCustom: true,
    },
  ],
});
if (parsedQuestionRequest.type !== "tool-question") {
  throw new Error("Question fixture must be a native question request.");
}
const questionRequest: AgentToolQuestionRequest = parsedQuestionRequest;

const interaction = {
  request: approvalRequest,
  runId: "run-1",
  status: "pending",
} satisfies ClientInteraction;

const imageCatalog: ImageModelCatalogItem[] = [
  {
    modelId: "image-model-1",
    name: "Image Model 1",
    label: "Image Model 1",
    hint: "",
    iconSvg: "",
    imageCapabilities: {
      aspectRatios: ["1:1", "16:9"],
      quality: ["auto", "high"],
      background: ["opaque", "transparent"],
      n: { min: 1, max: 4 },
    },
  },
];

describe("native interaction response construction", () => {
  it("builds the exact v1 allow-once approval response", () => {
    const response = buildApprovalResponse({ approved: true });

    expect(response).toEqual({ type: "tool-approval", approved: true });
    assertAgentInteractionResponse(approvalRequest, response);
  });

  it("trims a bounded rejection reason without adding policy fields", () => {
    const response = buildApprovalResponse({
      approved: false,
      reason: "  I do not want this tool to run.  ",
    });

    expect(response).toEqual({
      type: "tool-approval",
      approved: false,
      reason: "I do not want this tool to run.",
    });
    expect(response).not.toHaveProperty("grantScope");
    expect(response).not.toHaveProperty("overrideArgs");
    assertAgentInteractionResponse(approvalRequest, response);
  });

  it("builds one strict answer for every native question prompt", () => {
    const response = buildQuestionResponse({
      request: questionRequest,
      answers: [
        { questionId: "style", value: "minimal" },
        { questionId: "notes", value: "Keep the layout calm." },
      ],
    });

    expect(response).toEqual({
      type: "tool-question",
      answers: [
        { questionId: "style", value: "minimal" },
        { questionId: "notes", value: "Keep the layout calm." },
      ],
    });
    assertAgentInteractionResponse(questionRequest, response);
  });

  it("rejects incomplete, invalid-choice, and disallowed custom question answers through Anvia", () => {
    expect(() =>
      buildQuestionResponse({
        request: questionRequest,
        answers: [{ questionId: "style", value: "unknown" }],
      }),
    ).toThrow();
    expect(() =>
      buildQuestionResponse({
        request: questionRequest,
        answers: [
          { questionId: "style", value: "minimal" },
          { questionId: "notes", value: "" },
        ],
      }),
    ).toThrow();
  });

  it("accepts only the bounded image override settings", () => {
    expect(
      buildImageOverride({
        modelId: "image-model-1",
        aspectRatio: "16:9",
        quality: "high",
        background: "transparent",
        n: 2,
      }, { catalog: imageCatalog }),
    ).toEqual({
      modelId: "image-model-1",
      aspectRatio: "16:9",
      quality: "high",
      background: "transparent",
      n: 2,
    });
    expect(() => buildImageOverride({ unknown: true }, { catalog: imageCatalog })).toThrow();
    expect(() => buildImageOverride({ n: 0 }, { catalog: imageCatalog })).toThrow();
    expect(() => buildImageOverride({ n: 11 }, { catalog: imageCatalog })).toThrow();
    expect(() => buildImageOverride({ aspectRatio: "16:9" }, { catalog: imageCatalog })).toThrow();
    expect(() => buildImageOverride({ modelId: "unknown-model" }, { catalog: imageCatalog })).toThrow();
    expect(() => buildImageOverride({ modelId: "image-model-1", quality: "lossless" }, { catalog: imageCatalog })).toThrow();
    expect(() => buildImageOverride({ modelId: "image-model-1", n: 5 }, { catalog: imageCatalog })).toThrow();
    expect(() => buildImageOverride({ modelId: "image-model-1" }, { catalog: [{ ...imageCatalog[0]!, imageCapabilities: null }] })).toThrow();
  });
});

describe("stageThenRespond", () => {
  it("responds directly for allow-once without staging", async () => {
    const calls: string[] = [];
    const stage = vi.fn(async () => {
      calls.push("stage");
    });
    const respond = vi.fn(async () => {
      calls.push("respond");
    });

    await stageThenRespond({
      interaction,
      response: buildApprovalResponse({ approved: true }),
      stage,
      respond,
      inFlight: new Set(),
    });

    expect(stage).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      interactionId: approvalRequest.id,
      response: { type: "tool-approval", approved: true },
    });
    expect(calls).toEqual(["respond"]);
  });

  it("stages a session grant before sending the native response", async () => {
    const calls: string[] = [];
    const stage = vi.fn(async () => {
      calls.push("stage");
    });
    const respond = vi.fn(async () => {
      calls.push("respond");
    });

    await stageThenRespond({
      interaction,
      response: buildApprovalResponse({ approved: true }),
      policy: { grantScope: "session" },
      stage,
      respond,
      inFlight: new Set(),
    });

    expect(stage).toHaveBeenCalledWith({
      interactionId: approvalRequest.id,
      response: { type: "tool-approval", approved: true },
      grantScope: "session",
    });
    expect(respond).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["stage", "respond"]);
  });

  it("stages edited image settings while keeping them out of the native response", async () => {
    const stage = vi.fn(async () => {});
    const respond = vi.fn(async (_input: {
      interactionId: string;
      response: AgentInteractionResponse;
    }) => {});
    const response = buildApprovalResponse({ approved: true });

    await stageThenRespond({
      interaction,
      response,
      policy: {
        overrideArgs: buildImageOverride(
          { modelId: "image-model-1", n: 2 },
          { catalog: imageCatalog },
        ),
        imageCatalog,
      },
      stage,
      respond,
      inFlight: new Set(),
    });

    expect(stage).toHaveBeenCalledWith({
      interactionId: approvalRequest.id,
      response,
      overrideArgs: { modelId: "image-model-1", n: 2 },
    });
    expect(respond).toHaveBeenCalledWith({
      interactionId: approvalRequest.id,
      response,
    });
    expect(response).not.toHaveProperty("overrideArgs");
  });

  it("does not send the native response when staging fails and exposes a bounded error", async () => {
    const respond = vi.fn(async () => {});

    await expect(
      stageThenRespond({
        interaction,
        response: buildApprovalResponse({ approved: true }),
        policy: { grantScope: "session" },
        stage: async () => {
          throw new Error("raw redis details must not reach the UI");
        },
        respond,
        inFlight: new Set(),
      }),
    ).rejects.toMatchObject({
      code: "stage_failed",
      message: "Interaction policy could not be staged. Try again.",
    });
    expect(respond).not.toHaveBeenCalled();
  });

  it("rejects a duplicate submission while the first response is in flight", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const respond = vi.fn(async () => pending);
    const inFlight = new Set<string>();
    const first = stageThenRespond({
      interaction,
      response: buildApprovalResponse({ approved: true }),
      respond,
      inFlight,
    });

    await expect(
      stageThenRespond({
        interaction,
        response: buildApprovalResponse({ approved: true }),
        respond,
        inFlight,
      }),
    ).rejects.toMatchObject({ code: "duplicate" });
    release();
    await first;
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("keeps the same response retryable when the native response fails", async () => {
    const stage = vi.fn(async () => {});
    const respond = vi
      .fn<(input: { interactionId: string; response: AgentInteractionResponse }) => Promise<void>>()
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(undefined);
    const response = buildApprovalResponse({ approved: true });
    const inFlight = new Set<string>();
    await expect(
      stageThenRespond({
        interaction,
        response,
        policy: { grantScope: "session" },
        stage,
        respond,
        inFlight,
      }),
    ).rejects.toMatchObject({
      code: "response_failed",
      message: "Interaction response could not be sent. Try again.",
    });

    await stageThenRespond({
      interaction,
      response,
      policy: { grantScope: "session" },
      stage,
      respond,
      inFlight,
    });
    expect(stage).toHaveBeenNthCalledWith(1, {
      interactionId: approvalRequest.id,
      response,
      grantScope: "session",
    });
    expect(stage).toHaveBeenNthCalledWith(2, {
      interactionId: approvalRequest.id,
      response,
      grantScope: "session",
    });
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it("rejects policy staging for a question or an unapproved response", async () => {
    const questionInteraction = {
      request: questionRequest,
      runId: "run-2",
      status: "pending",
    } satisfies ClientInteraction;
    const stage = vi.fn(async () => {});
    const respond = vi.fn(async () => {});

    await expect(
      stageThenRespond({
        interaction: questionInteraction,
        response: buildQuestionResponse({
          request: questionRequest,
          answers: [
            { questionId: "style", value: "minimal" },
            { questionId: "notes", value: "notes" },
          ],
        }),
        policy: { grantScope: "session" },
        stage,
        respond,
        inFlight: new Set(),
      }),
    ).rejects.toThrow();
    expect(stage).not.toHaveBeenCalled();

    await expect(
      stageThenRespond({
        interaction,
        response: buildApprovalResponse({ approved: false }),
        policy: { overrideArgs: { n: 2 } },
        stage,
        respond,
        inFlight: new Set(),
      }),
    ).rejects.toThrow();
    expect(stage).not.toHaveBeenCalled();
  });
});

describe("stageInteractionPolicy", () => {
  it("sends only the interaction-scoped staging body", async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = { input, init };
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    await stageInteractionPolicy({
      interactionId: "interaction-approval-1",
      response: { type: "tool-approval", approved: true },
      grantScope: "session",
      overrideArgs: { modelId: "image-model-1", n: 2 },
    });

    expect(captured?.input).toBe(
      `${API_BASE}/api/chat/interactions/interaction-approval-1/stage`,
    );
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      response: { type: "tool-approval", approved: true },
      grantScope: "session",
      overrideArgs: { modelId: "image-model-1", n: 2 },
    });
    expect(String(captured?.input)).not.toContain("approvals");
    expect(String(captured?.input)).not.toContain("clarifications");
  });

  it("maps policy-store failures to bounded user-safe errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: "internal redis connection details",
            code: "INTERACTION_POLICY_UNAVAILABLE",
          }),
          { status: 503 },
        ),
      ),
    );

    await expect(
      stageInteractionPolicy({
        interactionId: "interaction-approval-1",
        response: { type: "tool-approval", approved: true },
        grantScope: "session",
      }),
    ).rejects.toThrow("Interaction policy is temporarily unavailable.");
    await expect(
      stageInteractionPolicy({
        interactionId: "interaction-approval-1",
        response: { type: "tool-approval", approved: true },
        grantScope: "session",
      }),
    ).rejects.not.toThrow("redis");
  });
});

describe("native interaction panels", () => {
  it("rejects an edited image approval without staging an override", async () => {
    const imageRequest = parseAgentInteractionRequest({
      ...approvalRequest,
      id: "interaction-image-reject-1",
      input: {
        modelId: "image-model-1",
        prompt: "a mountain landscape",
        n: 1,
      },
    });
    if (imageRequest.type !== "tool-approval") throw new Error("bad fixture");
    const harness = createNativeHarness(imageRequest);
    const stageRequests: RequestInfo[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/models?outputType=image")) {
          return new Response(
            JSON.stringify({
              models: imageCatalog.map((model) => ({
                ...model,
                imageCapabilities: model.imageCapabilities,
              })),
            }),
            { status: 200 },
          );
        }
        if (url.includes("/api/chat/interactions/") && url.endsWith("/stage")) {
          stageRequests.push(input);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        throw new Error(`Unexpected fetch in image rejection test: ${url}`);
      }),
    );

    render(
      createElement(
        NativeControllerHarness,
        { transport: harness.transport },
        createElement(ApprovalPanel),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "16:9" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));

    await vi.waitFor(() =>
      expect(
        harness.requests.filter((request) => request.type === "interaction_response"),
      ).toHaveLength(1),
    );
    expect(stageRequests).toHaveLength(0);
    expect(harness.requests.find((request) => request.type === "interaction_response")).toEqual({
      type: "interaction_response",
      interactionId: imageRequest.id,
      response: { type: "tool-approval", approved: false },
    });
  });

  it("renders a pending approval and sends exactly one native allow-once response", async () => {
    const webRequest = parseAgentInteractionRequest({
      ...approvalRequest,
      id: "interaction-web-1",
      toolName: "web_search",
      input: {
        url: "https://user:secret@example.com/report?token=private#fragment",
      },
      reason: "  Approval reason\u0000 with a bounded display.  ",
    });
    if (webRequest.type !== "tool-approval") throw new Error("bad fixture");
    const harness = createNativeHarness(webRequest);

    render(
      createElement(
        NativeControllerHarness,
        { transport: harness.transport },
        createElement(ApprovalPanel),
      ),
    );
    expect(await screen.findByText("https://example.com/report")).toBeTruthy();
    expect(screen.queryByText(/secret|token=private|fragment/)).toBeNull();
    expect(screen.getByText("Approval reason with a bounded display.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Allow for session" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Allow once" }));
    await vi.waitFor(() =>
      expect(
        harness.requests.filter((request) => request.type === "interaction_response"),
      ).toHaveLength(1),
    );
    expect(harness.requests.find((request) => request.type === "interaction_response")).toEqual({
      type: "interaction_response",
      interactionId: "interaction-web-1",
      response: { type: "tool-approval", approved: true },
    });
  });

  it("renders native question prompts and submits every required answer once", async () => {
    const harness = createNativeHarness(questionRequest);

    render(
      createElement(
        NativeControllerHarness,
        { transport: harness.transport },
        createElement(ClarificationPanel),
      ),
    );
    const submitButton = await screen.findByRole("button", { name: "Submit" });
    fireEvent.click(submitButton);
    await vi.waitFor(() => {
      const radioGroup = screen.getByRole("radiogroup");
      const notesInput = screen.getByRole("textbox", { name: "Any additional notes?" });
      expect(radioGroup.getAttribute("aria-required")).toBe("true");
      expect(radioGroup.getAttribute("aria-invalid")).toBe("true");
      expect(radioGroup.getAttribute("aria-describedby")).toContain("-error");
      expect(notesInput.getAttribute("aria-required")).toBe("true");
      expect(notesInput.getAttribute("aria-invalid")).toBe("true");
      expect(notesInput.getAttribute("aria-describedby")).toContain("-error");
      expect(screen.getAllByText("Answer required.")).toHaveLength(2);
    });
    fireEvent.click(await screen.findByRole("radio", { name: "Minimal" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Any additional notes?" }), {
      target: { value: "Use restrained spacing." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));
    await vi.waitFor(() =>
      expect(
        harness.requests.filter((request) => request.type === "interaction_response"),
      ).toHaveLength(1),
    );
    expect(harness.requests.find((request) => request.type === "interaction_response")).toEqual({
      type: "interaction_response",
      interactionId: questionRequest.id,
      response: {
        type: "tool-question",
        answers: [
          { questionId: "style", value: "minimal" },
          { questionId: "notes", value: "Use restrained spacing." },
        ],
      },
    });
  });
});

type NativeTestTransport = ClientTransport<
  ClientStreamRequest,
  ClientDataMap,
  ClientMetadata
>;

function NativeControllerHarness({
  transport,
  children,
}: {
  transport: NativeTestTransport;
  children?: ReactNode;
}) {
  const controller = useChat({ transport });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void controller.sendMessage({ text: "native interaction test" });
  }, [controller]);

  return createElement(ChatProvider, { controller }, children);
}

function createNativeHarness(pendingRequest: AgentInteractionRequest): {
  transport: NativeTestTransport;
  requests: ClientStreamRequest[];
} {
  const requests: ClientStreamRequest[] = [];
  const transport = createDirectClientTransport<
    ClientStreamRequest,
    ClientDataMap,
    ClientMetadata
  >({
    handler: ({ request }) => {
      requests.push(request);
      return nativeEvents(
        pendingRequest,
        request.type === "messages" ? "suspended" : "completed",
      );
    },
  });
  return { transport, requests };
}

async function* nativeEvents(
  interactionRequest: AgentInteractionRequest,
  status: "completed" | "suspended",
): AsyncGenerator<ClientStreamEvent<ClientMetadata, ClientDataMap>> {
  const runId = "native-test-run";
  yield { runId, type: "run_start", source: "agent" };
  if (status === "suspended") {
    yield { runId, type: "interaction", interaction: interactionRequest };
  }
  yield { runId, type: "run_end", status };
}

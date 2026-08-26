import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  parseAgentInteractionRequest,
} from "@anvia/core/agent/interactions";
import {
  interactionResponseFingerprint,
  InteractionPolicyConflictError,
} from "./interaction-policy-store.js";
import {
  InteractionClaimedError,
  InteractionExpiredError,
  InteractionOwnershipError,
  InteractionReplayedError,
} from "./interaction-store.js";

const USER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const SESSION_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const INTERACTION_ID = "interaction-1";

vi.mock("../auth/middleware.js", () => ({
  requireUser: async (
    c: { set: (key: string, value: unknown) => void },
    next: () => Promise<void>,
  ) => {
    c.set("user", { id: USER_ID, email: "ada@example.com", name: "Ada", image: null });
    await next();
  },
}));

vi.mock("./approval-registry.js", () => ({
  getApprovalRegistry: vi.fn(() => {
    throw new Error("staging must not activate the legacy approval registry");
  }),
}));

const { getInteraction, stagePolicy, findImageModel } = vi.hoisted(() => ({
  getInteraction: vi.fn(),
  stagePolicy: vi.fn(),
  findImageModel: vi.fn(),
}));

vi.mock("../../utils/prisma.js", () => ({
  prisma: { chatModel: { findFirst: findImageModel } },
}));

vi.mock("./interaction-store.js", async () => {
  const actual = await vi.importActual<typeof import("./interaction-store.js")>("./interaction-store.js");
  return {
    ...actual,
    getInteractionStore: vi.fn(() => ({ get: getInteraction, getForUser: getInteraction })),
  };
});

vi.mock("./interaction-policy-store.js", async () => {
  const actual = await vi.importActual<typeof import("./interaction-policy-store.js")>("./interaction-policy-store.js");
  return {
    ...actual,
    getInteractionPolicyStore: vi.fn(() => ({ stage: stagePolicy })),
  };
});

import { chatRouter } from "./router.js";

const request = parseAgentInteractionRequest({
  id: INTERACTION_ID,
  type: "tool-approval",
  toolName: "generate_image",
  toolCallId: "tool-call-1",
  internalCallId: "internal-call-1",
  input: { prompt: "create a mountain landscape" },
});

const record = {
  id: INTERACTION_ID,
  userId: USER_ID,
  sessionId: SESSION_ID,
  request,
  state: "pending" as const,
};

const app = new Hono().route("/api/chat", chatRouter);

describe("POST /api/chat/interactions/:interactionId/stage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInteraction.mockResolvedValue(record);
    stagePolicy.mockResolvedValue({ ...record, state: "staged" });
    findImageModel.mockResolvedValue({
      imageCapabilities: {
        aspectRatios: ["1:1", "16:9"],
        quality: ["auto", "high"],
        background: ["opaque", "transparent"],
        n: { min: 1, max: 4 },
      },
    });
  });

  it("validates the native response and writes only an interaction-scoped policy stage", async () => {
    const response = { type: "tool-approval", approved: true } as const;
    const result = await app.request(`/api/chat/interactions/${INTERACTION_ID}/stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        response,
        grantScope: "session",
        overrideArgs: { prompt: "a different mountain landscape", modelId: "image-model-1", aspectRatio: "16:9", n: 2 },
      }),
    });

    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ ok: true });
    expect(getInteraction).toHaveBeenCalledWith(INTERACTION_ID, USER_ID);
    expect(stagePolicy).toHaveBeenCalledWith({
      interactionId: INTERACTION_ID,
      userId: USER_ID,
      sessionId: SESSION_ID,
      toolName: "generate_image",
      responseFingerprint: interactionResponseFingerprint(response),
      grantScope: "session",
      overrideArgs: { prompt: "a different mountain landscape", modelId: "image-model-1", aspectRatio: "16:9", n: 2 },
    });
  });

  it("does not write or activate policy for a malformed or unapproved stage", async () => {
    for (const body of [
      { response: { type: "tool-approval", approved: false } },
      { response: { type: "tool-approval", approved: true }, overrideArgs: { unknown: true } },
      { response: { type: "tool-approval", approved: true }, overrideArgs: { n: 11 } },
      { response: { type: "tool-approval", approved: true }, overrideArgs: { aspectRatio: "16:9" } },
      { response: { type: "tool-approval", approved: true }, overrideArgs: { modelId: "image-model-1", aspectRatio: "unsupported" } },
      { response: { type: "tool-approval", approved: true }, grantScope: "all" },
    ]) {
      const result = await app.request(`/api/chat/interactions/${INTERACTION_ID}/stage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(result.status).toBe(400);
    }
    expect(stagePolicy).not.toHaveBeenCalled();
  });

  it("fails closed when the authoritative image model or capabilities are unavailable", async () => {
    for (const imageCapabilities of [null, { n: { min: 1, max: 4 }, unknown: true }]) {
      findImageModel.mockResolvedValueOnce(
        imageCapabilities === null ? null : { imageCapabilities },
      );
      const result = await app.request(`/api/chat/interactions/${INTERACTION_ID}/stage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          response: { type: "tool-approval", approved: true },
          overrideArgs: { modelId: "missing-or-invalid", n: 2 },
        }),
      });
      expect(result.status).toBe(400);
    }
    expect(stagePolicy).not.toHaveBeenCalled();
  });

  it("rejects staging for a question interaction before writing policy", async () => {
    getInteraction.mockResolvedValue({
      ...record,
      request: parseAgentInteractionRequest({
        id: INTERACTION_ID,
        type: "tool-question",
        toolName: "deep_research",
        toolCallId: "tool-call-1",
        internalCallId: "internal-call-1",
        questions: [{ id: "answer", text: "Which scope?", allowCustom: true }],
      }),
    });
    const result = await app.request(`/api/chat/interactions/${INTERACTION_ID}/stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { type: "tool-approval", approved: true } }),
    });
    expect(result.status).toBe(400);
    expect(stagePolicy).not.toHaveBeenCalled();
  });

  it("fails closed for wrong ownership and state without exposing interaction data", async () => {
    getInteraction.mockRejectedValue(new InteractionOwnershipError(INTERACTION_ID));
    const result = await app.request(`/api/chat/interactions/${INTERACTION_ID}/stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { type: "tool-approval", approved: true } }),
    });
    expect(result.status).toBe(404);
    expect(await result.json()).toEqual({ error: "interaction not found", code: "INTERACTION_NOT_FOUND" });
    expect(stagePolicy).not.toHaveBeenCalled();

    getInteraction.mockResolvedValue({ ...record, state: "consumed" });
    const consumed = await app.request(`/api/chat/interactions/${INTERACTION_ID}/stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { type: "tool-approval", approved: true } }),
    });
    expect(consumed.status).toBe(409);
    expect(await consumed.json()).toMatchObject({ code: "INTERACTION_STATE_CONFLICT" });
    expect(stagePolicy).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", InteractionExpiredError, "INTERACTION_EXPIRED"],
    ["replayed", InteractionReplayedError, "INTERACTION_REPLAYED"],
    ["claimed", InteractionClaimedError, "INTERACTION_CLAIMED"],
  ])("returns the terminal state only after the owner-aware lookup proves ownership: %s", async (_state, ErrorType, code) => {
    getInteraction.mockRejectedValueOnce(new ErrorType(INTERACTION_ID));
    const result = await app.request(`/api/chat/interactions/${INTERACTION_ID}/stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { type: "tool-approval", approved: true } }),
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ code });
    expect(stagePolicy).not.toHaveBeenCalled();
  });

  it("maps an exact existing stage to success but reports a changed policy as conflict", async () => {
    stagePolicy.mockResolvedValueOnce({ ...record, state: "staged" });
    const first = await app.request(`/api/chat/interactions/${INTERACTION_ID}/stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: { type: "tool-approval", approved: true } }),
    });
    expect(first.status).toBe(200);

    stagePolicy.mockRejectedValueOnce(new InteractionPolicyConflictError("conflict"));
    const second = await app.request(`/api/chat/interactions/${INTERACTION_ID}/stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        response: { type: "tool-approval", approved: true },
        overrideArgs: { prompt: "changed", modelId: "image-model-1" },
      }),
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "INTERACTION_POLICY_CONFLICT" });
  });
});

describe("GET /api/chat/interactions/:interactionId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getInteraction.mockResolvedValue(record);
  });

  it("reports pending when the owner can still answer", async () => {
    const result = await app.request(`/api/chat/interactions/${INTERACTION_ID}`);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ status: "pending" });
  });

  it("masks expired and foreign records as unavailable", async () => {
    getInteraction.mockRejectedValueOnce(new InteractionExpiredError(INTERACTION_ID));
    const expired = await app.request(`/api/chat/interactions/${INTERACTION_ID}`);
    expect(expired.status).toBe(200);
    expect(await expired.json()).toEqual({ status: "unavailable" });

    getInteraction.mockRejectedValueOnce(new InteractionOwnershipError(INTERACTION_ID));
    const foreign = await app.request(`/api/chat/interactions/${INTERACTION_ID}`);
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ status: "unavailable" });
  });
});

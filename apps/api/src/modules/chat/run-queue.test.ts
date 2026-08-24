import { describe, expect, it } from "vitest";
import { parseMessage } from "@anvia/core/completion";
import {
  parseAgentContinuation,
  parseAgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import {
  parseChatRunJobData,
  type ChatRunJobData,
} from "./run-queue.js";
import {
  attachChatAgentRecipeClaim,
  CHAT_AGENT_ID,
  parseChatAgentRecipe,
} from "./run-recipe.js";
import { enqueueChatRun } from "./run-queue.js";

const recipe = parseChatAgentRecipe({
  version: 1,
  agentId: CHAT_AGENT_ID,
  identity: { sessionId: "session-1", userId: "user-1", projectId: null },
  model: { id: "openai/gpt-5.6-luna", reasoningEffort: "medium" },
  features: {
    webSearchEnabled: false,
    imageGenerationEnabled: false,
    deepResearchEnabled: false,
  },
  imageGenSettings: null,
  budgets: { maxTurns: 20, deepResearchMaxTurns: 8, deepResearchMaxSearches: 12 },
  documents: { ids: [], catalog: [] },
  instructionFragments: [],
  contextDescriptors: [],
  activeContext: { images: [], snippet: null },
  capabilities: {
    modelAcceptsImage: false,
    webSearchAvailable: false,
    imageGenerationAvailable: false,
    deepResearchAvailable: false,
    profilingEnabled: false,
    context7Requested: false,
    imageModelCapabilities: [],
  },
  promptClientMessageId: null,
  trace: { traceId: "trace-1" },
});

const prompt = parseMessage({
  role: "user",
  content: "Hello",
  metadata: { clientMessageId: "client-message-1" },
});

const continuation = parseAgentContinuation({
  version: 1,
  agentId: CHAT_AGENT_ID,
  sourceRunId: "run-1",
  interaction: {
    id: "interaction-1",
    type: "tool-approval",
    toolName: "web_search",
    toolCallId: "tool-call-1",
    internalCallId: "internal-call-1",
    input: { query: "Anvia" },
  },
  state: { cursor: 1 },
});

const response = parseAgentInteractionResponse({
  type: "tool-approval",
  approved: true,
});

function startJob(): ChatRunJobData {
  return {
    kind: "start",
    streamId: "stream-1",
    sessionId: "session-1",
    userId: "user-1",
    recipe,
    prompt,
    createdAt: "2026-08-24T00:00:00.000Z",
  };
}

function resumeJob(): ChatRunJobData {
  return {
    kind: "resume",
    streamId: "stream-2",
    sessionId: "session-1",
    userId: "user-1",
    recipe,
    continuation,
    response,
    sourceInteractionId: continuation.interaction.id,
    createdAt: "2026-08-24T00:00:00.000Z",
  };
}

describe("ChatRunJobData", () => {
  it("accepts strict start and resume jobs", () => {
    expect(parseChatRunJobData(startJob())).toEqual(startJob());
    expect(parseChatRunJobData(resumeJob())).toEqual(resumeJob());
    expect(parseChatRunJobData(JSON.parse(JSON.stringify(startJob())))).toEqual(
      startJob(),
    );
    expect(parseChatRunJobData(JSON.parse(JSON.stringify(resumeJob())))).toEqual(
      resumeJob(),
    );
  });

  it("rejects the legacy flat prompt job and unknown fields", () => {
    expect(() =>
      parseChatRunJobData({
        ...startJob(),
        kind: undefined,
        model: recipe.model.id,
        promptMessage: prompt,
      }),
    ).toThrow();
    expect(() => parseChatRunJobData({ ...startJob(), secret: "nope" })).toThrow();
  });

  it("rejects cross-identity jobs and invalid start/resume fields", () => {
    expect(() =>
      parseChatRunJobData({ ...startJob(), userId: "other-user" }),
    ).toThrow();
    expect(() =>
      parseChatRunJobData({ ...resumeJob(), prompt }),
    ).toThrow();
    expect(() =>
      parseChatRunJobData({ ...startJob(), continuation, response }),
    ).toThrow();
    expect(() =>
      parseChatRunJobData({ ...resumeJob(), sourceInteractionId: "other-interaction" }),
    ).toThrow();
  });

  it("rejects a continuation with the wrong agent id or response type", () => {
    const wrongAgent = parseAgentContinuation({
      ...continuation,
      agentId: "other-agent",
    });
    expect(() =>
      parseChatRunJobData({ ...resumeJob(), continuation: wrongAgent }),
    ).toThrow();

    const questionResponse = parseAgentInteractionResponse({
      type: "tool-question",
      answers: [{ questionId: "question-1", value: "yes" }],
    });
    expect(() =>
      parseChatRunJobData({ ...resumeJob(), response: questionResponse }),
    ).toThrow();
  });

  it("rejects invalid jobs before BullMQ add", async () => {
    let adds = 0;
    await expect(
      enqueueChatRun(
        "job-invalid-before-add",
        { ...startJob(), secret: "nope" } as never,
        {
          add: async () => {
            adds += 1;
            return {} as never;
          },
        },
      ),
    ).rejects.toThrow();
    expect(adds).toBe(0);
  });

  it("releases a claimed context recipe when enqueue fails", async () => {
    let released = 0;
    const claimedRecipe = parseChatAgentRecipe(recipe);
    attachChatAgentRecipeClaim(claimedRecipe, {
      commit: async () => {},
      release: async () => {
        released += 1;
      },
    });

    await expect(
      enqueueChatRun(
        "job-1",
        { ...startJob(), recipe: claimedRecipe },
        {
          add: async () => {
            throw new Error("redis unavailable");
          },
        },
      ),
    ).rejects.toThrow("redis unavailable");
    expect(released).toBe(1);
  });

  it("commits a claimed context recipe after the queue accepts the job", async () => {
    let committed = 0;
    const claimedRecipe = parseChatAgentRecipe(recipe);
    attachChatAgentRecipeClaim(claimedRecipe, {
      commit: async () => {
        committed += 1;
      },
      release: async () => {},
    });

    await enqueueChatRun(
      "job-accepted",
      { ...startJob(), recipe: claimedRecipe },
      { add: async () => ({}) as never },
    );

    expect(committed).toBe(1);
  });

  it("does not release durable context after the job is accepted but commit fails", async () => {
    let released = 0;
    const claimedRecipe = parseChatAgentRecipe(recipe);
    attachChatAgentRecipeClaim(claimedRecipe, {
      commit: async () => {
        throw new Error("database unavailable");
      },
      release: async () => {
        released += 1;
      },
    });

    await expect(
      enqueueChatRun(
        "job-commit-failed",
        { ...startJob(), recipe: claimedRecipe },
        { add: async () => ({}) as never },
      ),
    ).rejects.toThrow("database unavailable");
    expect(released).toBe(0);
  });

  it("keeps a failed rollback claim retryable instead of swallowing the error", async () => {
    let releaseAttempts = 0;
    const claimedRecipe = parseChatAgentRecipe(recipe);
    attachChatAgentRecipeClaim(claimedRecipe, {
      commit: async () => {},
      release: async () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("rollback unavailable");
      },
    });

    await expect(
      enqueueChatRun(
        "job-rollback-failed",
        { ...startJob(), recipe: claimedRecipe },
        { add: async () => { throw new Error("redis unavailable"); } },
      ),
    ).rejects.toThrow("context rollback failed");

    // The retained out-of-band handle can be retried after the dependency
    // recovers; a failed first rollback must not lose the only release path.
    await enqueueChatRun(
      "job-rollback-retry",
      { ...startJob(), recipe: claimedRecipe },
      { add: async () => { throw new Error("redis unavailable"); } },
    ).catch(() => {});
    expect(releaseAttempts).toBe(2);
  });
});

import {
  defineGuardrailPolicy,
  guardrails,
  type CompletionModel,
  type MemoryStore,
} from "@anvia/core";
import type {
  AgentObservabilityOptions,
  AgentObserver,
} from "@anvia/core/observability";
import { describe, expect, it } from "vitest";
import { createAgent } from "./agent.js";
import { BASE_INSTRUCTIONS } from "./prompts/base-instructions.js";

const model = {
  provider: "test",
  modelId: "test/model",
  completion: async () => {
    throw new Error("not called");
  },
} as unknown as CompletionModel;

const memory = {} as MemoryStore;
const observer = {
  startRun: () => undefined,
} satisfies AgentObserver;
const observability = {
  observers: { test: observer },
  primaryTrace: "test",
  errorPolicy: "throw",
} satisfies AgentObservabilityOptions;

describe("createAgent", () => {
  it("builds a reusable v1 Agent from declarative options", () => {
    const agent = createAgent({
      agentId: "chat-agent",
      model,
      reasoningEffort: "max",
      maxTurns: 12,
      additionalInstructions: ["First policy.", "Second policy."],
      additionalContext: [
        { id: "project", text: " Project A " },
        { text: "Second fact" },
        { id: "empty", text: "   " },
      ],
      memory,
      observability,
    });

    expect(agent.id).toBe("chat-agent");
    expect(agent.model).toBe(model);
    expect(agent.instructions).toBe(
      [BASE_INSTRUCTIONS.trim(), "First policy.", "Second policy."].join(
        "\n\n",
      ),
    );
    expect(agent.context).toEqual([
      { id: "project", text: "Project A" },
      { id: "context-1", text: "Second fact" },
    ]);
    expect(agent.providerOptions).toEqual({
      reasoning: { effort: "max", summary: "auto" },
    });
    expect(agent.defaultMaxTurns).toBe(12);
    expect(agent.memory).toMatchObject({ store: memory, savePolicy: "turn" });
    expect(agent.observability).toEqual(observability);
  });

  it("creates isolated context arrays for scoped agents", () => {
    const first = createAgent({
      agentId: "chat-agent",
      model,
      additionalContext: [{ id: "project", text: "Project A" }],
    });
    const second = createAgent({
      agentId: "chat-agent",
      model,
      additionalContext: [{ id: "project", text: "Project B" }],
    });

    expect(first).not.toBe(second);
    expect(first.context).toEqual([{ id: "project", text: "Project A" }]);
    expect(second.context).toEqual([{ id: "project", text: "Project B" }]);
  });

  it("forwards declarative guardrails to the native Agent", () => {
    const policy = defineGuardrailPolicy({
      id: "test-policy",
      input: [
        guardrails.blockText({
          id: "block-input",
          boundary: "input",
          patterns: [/blocked/],
          reason: "fixture blocked",
        }),
      ],
    });
    const agent = createAgent({
      agentId: "chat-agent",
      model,
      guardrails: policy,
    });

    expect(agent.guardrails).toHaveLength(1);
    expect(agent.guardrails[0]?.id).toBe("test-policy");
  });
});

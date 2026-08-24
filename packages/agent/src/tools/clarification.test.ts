import { describe, expect, it } from "vitest";
import { isQuestionTool } from "@anvia/core/tool";
import { parseAgentInteractionRequest } from "@anvia/core/agent/interactions";
import {
  CLARIFICATION_INSTRUCTION,
  createClarificationTool,
} from "./clarification.js";

describe("createClarificationTool", () => {
  it("creates Anvia's native request_clarification question tool", () => {
    const tool = createClarificationTool();

    expect(tool.name).toBe("request_clarification");
    expect(isQuestionTool(tool)).toBe(true);
  });

  it("accepts bounded single-choice and custom-text questions", () => {
    const tool = createClarificationTool();

    expect(
      tool.parseInput({
        questions: [
          {
            id: "scope",
            text: "Which document scope should I use?",
            choices: [
              { label: "All documents", value: "all" },
              { label: "Active document", value: "active" },
            ],
            allowCustom: true,
          },
          {
            id: "notes",
            text: "What constraints should I follow?",
          },
        ],
      }),
    ).toEqual({
      questions: [
        {
          id: "scope",
          text: "Which document scope should I use?",
          choices: [
            { label: "All documents", value: "all" },
            { label: "Active document", value: "active" },
          ],
          allowCustom: true,
        },
        {
          id: "notes",
          text: "What constraints should I follow?",
        },
      ],
    });
  });

  it("rejects duplicate question ids", () => {
    const tool = createClarificationTool();

    const input = tool.parseInput({
        questions: [
          { id: "scope", text: "First?" },
          { id: "scope", text: "Second?" },
        ],
      });

    expect(() =>
      parseAgentInteractionRequest({
        type: "tool-question",
        id: "interaction-1",
        toolName: tool.name,
        toolCallId: "call-1",
        internalCallId: "internal-1",
        questions: input.questions,
      }),
    ).toThrow(/unique/i);
  });

  it("cannot execute as an ordinary tool call", async () => {
    const tool = createClarificationTool();

    await expect(
      tool.call({ questions: [{ id: "scope", text: "Which scope?" }] }),
    ).rejects.toThrow(/interaction/i);
  });
});

describe("CLARIFICATION_INSTRUCTION", () => {
  it("guides the model to required native question semantics", () => {
    expect(CLARIFICATION_INSTRUCTION).toMatch(/request_clarification/);
    expect(CLARIFICATION_INSTRUCTION).toMatch(/every question/i);
    expect(CLARIFICATION_INSTRUCTION).toMatch(
      /not use request_clarification for permission/i,
    );
    expect(CLARIFICATION_INSTRUCTION).not.toMatch(
      /optional|recommended|timeout/i,
    );
  });
});

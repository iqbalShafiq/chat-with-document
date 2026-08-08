import { describe, expect, it, vi } from "vitest";
import {
  CLARIFICATION_INSTRUCTION,
  createClarificationTool,
  type ClarificationResponse,
} from "./clarification.js";

function requester(responses: ClarificationResponse) {
  return vi.fn().mockResolvedValue(responses);
}

describe("createClarificationTool", () => {
  it("exposes the request_clarification tool name", () => {
    const tool = createClarificationTool({ requester: vi.fn() });
    expect(tool.name).toBe("request_clarification");
  });

  it("forwards a valid request to the requester and maps an answered response", async () => {
    const req = requester({
      answers: { style: "flat", tags: ["minimal", "warm"] },
      skipped: ["subject"],
      timedOut: false,
    });
    const tool = createClarificationTool({ requester: req });

    const result = await tool.call({
      title: "Logo direction",
      questions: [
        {
          id: "style",
          question: "Which visual style?",
          type: "single_choice",
          options: [
            { id: "flat", label: "Flat" },
            { id: "3d", label: "3D", recommended: true },
          ],
        },
        {
          id: "tags",
          question: "Pick any tags",
          type: "multiple_choice",
          optional: true,
          options: [
            { id: "minimal", label: "Minimal" },
            { id: "warm", label: "Warm" },
          ],
        },
      ],
    });

    expect(req).toHaveBeenCalledWith({
      title: "Logo direction",
      questions: [
        {
          id: "style",
          question: "Which visual style?",
          type: "single_choice",
          options: [
            { id: "flat", label: "Flat" },
            { id: "3d", label: "3D", recommended: true },
          ],
        },
        {
          id: "tags",
          question: "Pick any tags",
          type: "multiple_choice",
          optional: true,
          options: [
            { id: "minimal", label: "Minimal" },
            { id: "warm", label: "Warm" },
          ],
        },
      ],
    });
    expect(result).toEqual({
      status: "answered",
      answers: { style: "flat", tags: ["minimal", "warm"] },
      skipped: ["subject"],
      note: expect.stringContaining("recommended"),
    });
  });

  it("maps a timed-out response to status timed_out with an explanatory note", async () => {
    const req = requester({
      answers: {},
      skipped: ["style"],
      timedOut: true,
    });
    const tool = createClarificationTool({ requester: req });

    const result = await tool.call({
      questions: [
        {
          id: "style",
          question: "Which style?",
          type: "free_text",
          placeholder: "Describe it",
        },
      ],
    });

    expect(result.status).toBe("timed_out");
    expect(result.note).toMatch(/did not respond in time/i);
    expect(result.note).toMatch(/recommended/i);
  });

  describe("input validation", () => {
    const tool = createClarificationTool({ requester: vi.fn() });

    it("rejects more than 5 questions", async () => {
      const questions = Array.from({ length: 6 }, (_, index) => ({
        id: `q${index}`,
        question: `Question ${index}`,
        type: "free_text" as const,
      }));
      await expect(tool.call({ questions })).rejects.toThrow();
    });

    it("rejects a choice question without options", async () => {
      await expect(
        tool.call({
          questions: [
            {
              id: "style",
              question: "Which style?",
              type: "single_choice",
            },
          ],
        }),
      ).rejects.toThrow();
    });

    it("rejects free_text questions that carry options", async () => {
      await expect(
        tool.call({
          questions: [
            {
              id: "style",
              question: "Which style?",
              type: "free_text",
              options: [
                { id: "flat", label: "Flat" },
                { id: "3d", label: "3D" },
              ],
            },
          ],
        }),
      ).rejects.toThrow();
    });

    it("rejects an empty question id", async () => {
      await expect(
        tool.call({
          questions: [{ id: "", question: "What?", type: "free_text" }],
        }),
      ).rejects.toThrow();
    });

    it("rejects options with fewer than 2 entries", async () => {
      await expect(
        tool.call({
          questions: [
            {
              id: "style",
              question: "Which style?",
              type: "multiple_choice",
              options: [{ id: "flat", label: "Flat" }],
            },
          ],
        }),
      ).rejects.toThrow();
    });
  });
});

describe("CLARIFICATION_INSTRUCTION", () => {
  it("guides the model on recommended choices and optional questions", () => {
    expect(CLARIFICATION_INSTRUCTION).toMatch(/request_clarification/);
    expect(CLARIFICATION_INSTRUCTION).toMatch(/recommended/i);
    expect(CLARIFICATION_INSTRUCTION).toMatch(/optional/i);
    expect(CLARIFICATION_INSTRUCTION).toMatch(/not use request_clarification for permission/i);
  });
});

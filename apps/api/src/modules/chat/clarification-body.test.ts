import { describe, expect, it } from "vitest";
import { parseClarificationResponseBody } from "./clarification-body.js";

describe("parseClarificationResponseBody", () => {
  it("parses string and array answers with skipped", () => {
    const parsed = parseClarificationResponseBody({
      answers: { style: "minimalist", colors: ["blue", "green"] },
      skipped: ["optional_question"],
    });
    expect(parsed).toEqual({
      answers: { style: "minimalist", colors: ["blue", "green"] },
      skipped: ["optional_question"],
    });
  });

  it("defaults missing skipped to an empty array", () => {
    const parsed = parseClarificationResponseBody({ answers: { style: "x" } });
    expect(parsed).toEqual({ answers: { style: "x" }, skipped: [] });
  });

  it("accepts an empty answers object", () => {
    const parsed = parseClarificationResponseBody({
      answers: {},
      skipped: [],
    });
    expect(parsed).toEqual({ answers: {}, skipped: [] });
  });

  it("returns null for a non-object body", () => {
    expect(parseClarificationResponseBody(null)).toBeNull();
    expect(parseClarificationResponseBody("answers")).toBeNull();
    expect(parseClarificationResponseBody([{ answers: {} }])).toBeNull();
  });

  it("returns null when answers is missing or not an object", () => {
    expect(parseClarificationResponseBody({ skipped: [] })).toBeNull();
    expect(parseClarificationResponseBody({ answers: "no", skipped: [] })).toBeNull();
  });

  it("returns null when an answer value is not a string or string array", () => {
    expect(
      parseClarificationResponseBody({ answers: { style: 42 } }),
    ).toBeNull();
    expect(
      parseClarificationResponseBody({ answers: { style: [1, 2] } }),
    ).toBeNull();
    expect(
      parseClarificationResponseBody({ answers: { style: ["a", 2] } }),
    ).toBeNull();
  });

  it("returns null when skipped is not a string array", () => {
    expect(
      parseClarificationResponseBody({ answers: {}, skipped: "none" }),
    ).toBeNull();
    expect(
      parseClarificationResponseBody({ answers: {}, skipped: [1] }),
    ).toBeNull();
  });

  it("rejects an answer string longer than 2000 characters", () => {
    expect(
      parseClarificationResponseBody({ answers: { style: "x".repeat(2001) } }),
    ).toBeNull();
  });

  it("accepts an answer string of exactly 2000 characters", () => {
    const parsed = parseClarificationResponseBody({
      answers: { style: "x".repeat(2000) },
    });
    expect(parsed?.answers.style).toBe("x".repeat(2000));
  });

  it("rejects an array answer with more than 8 items", () => {
    expect(
      parseClarificationResponseBody({
        answers: { colors: Array.from({ length: 9 }, () => "red") },
      }),
    ).toBeNull();
  });

  it("accepts an array answer with exactly 8 items", () => {
    const parsed = parseClarificationResponseBody({
      answers: { colors: Array.from({ length: 8 }, () => "red") },
    });
    expect(parsed?.answers.colors).toHaveLength(8);
  });

  it("rejects an array answer whose item exceeds 2000 characters", () => {
    expect(
      parseClarificationResponseBody({
        answers: { colors: ["red", "x".repeat(2001)] },
      }),
    ).toBeNull();
  });

  it("rejects more than 10 answer keys", () => {
    const answers: Record<string, string> = {};
    for (let i = 0; i < 11; i++) answers[`q${i}`] = "a";
    expect(parseClarificationResponseBody({ answers })).toBeNull();
  });

  it("accepts exactly 10 answer keys", () => {
    const answers: Record<string, string> = {};
    for (let i = 0; i < 10; i++) answers[`q${i}`] = "a";
    const parsed = parseClarificationResponseBody({ answers });
    expect(Object.keys(parsed!.answers)).toHaveLength(10);
  });

  it("rejects more than 10 skipped items", () => {
    expect(
      parseClarificationResponseBody({
        answers: {},
        skipped: Array.from({ length: 11 }, () => "q"),
      }),
    ).toBeNull();
  });

  it("rejects a skipped item longer than 100 characters", () => {
    expect(
      parseClarificationResponseBody({
        answers: {},
        skipped: ["x".repeat(101)],
      }),
    ).toBeNull();
  });

  it("accepts skipped items of exactly 100 characters", () => {
    const parsed = parseClarificationResponseBody({
      answers: {},
      skipped: ["x".repeat(100)],
    });
    expect(parsed?.skipped).toEqual(["x".repeat(100)]);
  });
});

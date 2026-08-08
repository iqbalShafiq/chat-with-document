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
});

import { describe, expect, it } from "vitest";
import {
  buildClarificationPayload,
  canSubmit,
  wizardReducer,
  type WizardState,
} from "./clarification-wizard";

const initial: WizardState = { step: 0, answers: {}, skipped: [] };

const QUESTIONS = [
  { id: "style", optional: false },
  { id: "size", optional: true },
  { id: "palette", optional: false },
];

describe("wizardReducer", () => {
  it("next advances the step", () => {
    expect(wizardReducer(initial, { type: "next" }).step).toBe(1);
  });

  it("next clamps at questionsLength - 1", () => {
    let state = wizardReducer(initial, { type: "next" });
    state = wizardReducer(state, { type: "next" });
    const atLast = wizardReducer(state, {
      type: "next",
      questionsLength: 3,
    });
    expect(atLast.step).toBe(2);
    const clamped = wizardReducer(atLast, {
      type: "next",
      questionsLength: 3,
    });
    expect(clamped.step).toBe(2);
  });

  it("next without questionsLength does not clamp the upper bound", () => {
    expect(wizardReducer(initial, { type: "next" }).step).toBe(1);
    expect(
      wizardReducer({ ...initial, step: 4 }, { type: "next" }).step,
    ).toBe(5);
  });

  it("back goes to the previous step", () => {
    expect(wizardReducer({ ...initial, step: 2 }, { type: "back" }).step).toBe(
      1,
    );
  });

  it("back clamps at zero", () => {
    expect(wizardReducer(initial, { type: "back" }).step).toBe(0);
  });

  it("answer stores the value and removes the question from skipped", () => {
    const skipped = wizardReducer(initial, {
      type: "skip",
      questionId: "style",
    });
    expect(skipped.skipped).toEqual(["style"]);

    const answered = wizardReducer(skipped, {
      type: "answer",
      questionId: "style",
      value: "minimal",
    });
    expect(answered.answers).toEqual({ style: "minimal" });
    expect(answered.skipped).toEqual([]);
  });

  it("answer with an empty string removes the stored answer", () => {
    const answered = wizardReducer(initial, {
      type: "answer",
      questionId: "palette",
      value: "dark",
    });
    const cleared = wizardReducer(answered, {
      type: "answer",
      questionId: "palette",
      value: "",
    });
    expect(cleared.answers).toEqual({});
  });

  it("answer with an empty array removes the stored answer", () => {
    const answered = wizardReducer(initial, {
      type: "answer",
      questionId: "style",
      value: ["a", "b"],
    });
    const cleared = wizardReducer(answered, {
      type: "answer",
      questionId: "style",
      value: [],
    });
    expect(cleared.answers).toEqual({});
  });

  it("skip adds the question id to skipped without touching answers", () => {
    const answered = wizardReducer(initial, {
      type: "answer",
      questionId: "palette",
      value: "dark",
    });
    const skipped = wizardReducer(answered, {
      type: "skip",
      questionId: "size",
    });
    expect(skipped.skipped).toEqual(["size"]);
    expect(skipped.answers).toEqual({ palette: "dark" });
  });

  it("reset clears step, answers and skipped", () => {
    const filled: WizardState = {
      step: 2,
      answers: { palette: "dark" },
      skipped: ["size"],
    };
    expect(wizardReducer(filled, { type: "reset" })).toEqual(initial);
  });

  it("answer without a question id is a no-op", () => {
    expect(
      wizardReducer(initial, { type: "answer", value: "x" }),
    ).toEqual(initial);
  });
});

describe("canSubmit", () => {
  it("is true when every question is answered", () => {
    const state: WizardState = {
      step: 0,
      answers: { style: "minimal", size: "m", palette: "dark" },
      skipped: [],
    };
    expect(canSubmit(state, QUESTIONS)).toBe(true);
  });

  it("is true when every question is either answered or skipped", () => {
    const state: WizardState = {
      step: 0,
      answers: { style: "minimal", palette: "dark" },
      skipped: ["size"],
    };
    expect(canSubmit(state, QUESTIONS)).toBe(true);
  });

  it("is false when a required question is unresolved", () => {
    const state: WizardState = {
      step: 0,
      answers: { style: "minimal" },
      skipped: [],
    };
    expect(canSubmit(state, QUESTIONS)).toBe(false);
  });

  it("is false when an optional question is neither answered nor skipped", () => {
    const state: WizardState = {
      step: 0,
      answers: { style: "minimal", palette: "dark" },
      skipped: [],
    };
    expect(canSubmit(state, QUESTIONS)).toBe(false);
  });

  it("is false when an empty-string answer counts as unresolved", () => {
    const state: WizardState = {
      step: 0,
      answers: { style: "minimal", size: "", palette: "dark" },
      skipped: [],
    };
    expect(canSubmit(state, QUESTIONS)).toBe(false);
  });
});

describe("buildClarificationPayload", () => {
  it("includes answers for resolved non-skipped questions only", () => {
    const state: WizardState = {
      step: 0,
      answers: { style: "minimal", size: "m", palette: "dark" },
      skipped: ["size"],
    };
    expect(buildClarificationPayload(state, QUESTIONS)).toEqual({
      answers: { style: "minimal", palette: "dark" },
      skipped: ["size"],
    });
  });

  it("keeps skipped ids in question order and drops unknown ids", () => {
    const state: WizardState = {
      step: 0,
      answers: { style: "minimal", ghost: "ignored" },
      skipped: ["palette", "unknown"],
    };
    expect(buildClarificationPayload(state, QUESTIONS)).toEqual({
      answers: { style: "minimal" },
      skipped: ["palette"],
    });
  });
});

export type WizardState = {
  step: number;
  answers: Record<string, string | string[]>;
  skipped: string[];
};

export type WizardAction = {
  type: "next" | "back" | "answer" | "skip" | "reset";
  questionId?: string;
  value?: string | string[];
  questionsLength?: number;
};

const EMPTY: WizardState = { step: 0, answers: {}, skipped: [] };

function isEmptyAnswer(value: string | string[]): boolean {
  return (
    value === "" || (Array.isArray(value) && value.length === 0)
  );
}

export function wizardReducer(
  state: WizardState,
  action: WizardAction,
): WizardState {
  switch (action.type) {
    case "next": {
      const next = state.step + 1;
      if (typeof action.questionsLength === "number") {
        return {
          ...state,
          step: Math.min(next, Math.max(0, action.questionsLength - 1)),
        };
      }
      return { ...state, step: next };
    }
    case "back":
      return { ...state, step: Math.max(0, state.step - 1) };
    case "answer": {
      if (action.questionId === undefined || action.value === undefined) {
        return state;
      }
      const answers = { ...state.answers };
      if (isEmptyAnswer(action.value)) {
        delete answers[action.questionId];
      } else {
        answers[action.questionId] = action.value;
      }
      return {
        ...state,
        answers,
        skipped: state.skipped.filter((id) => id !== action.questionId),
      };
    }
    case "skip": {
      if (action.questionId === undefined) return state;
      if (state.skipped.includes(action.questionId)) return state;
      return {
        ...state,
        skipped: [...state.skipped, action.questionId],
      };
    }
    case "reset":
      return EMPTY;
  }
}

export function canSubmit(
  state: WizardState,
  questions: { id: string; optional?: boolean }[],
): boolean {
  return questions.every((question) => {
    const answer = state.answers[question.id];
    return (
      (answer !== undefined && !isEmptyAnswer(answer)) ||
      state.skipped.includes(question.id)
    );
  });
}

export function buildClarificationPayload(
  state: WizardState,
  questions: { id: string; optional?: boolean }[],
): { answers: Record<string, string | string[]>; skipped: string[] } {
  const answers: Record<string, string | string[]> = {};
  const skipped: string[] = [];
  for (const question of questions) {
    if (state.skipped.includes(question.id)) {
      skipped.push(question.id);
      continue;
    }
    const answer = state.answers[question.id];
    if (answer !== undefined && !isEmptyAnswer(answer)) {
      answers[question.id] = answer;
    }
  }
  return { answers, skipped };
}

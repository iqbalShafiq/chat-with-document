import { useChatContext } from "@anvia/react-ui";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useEffect, useReducer, useState } from "react";
import { useClarifications } from "#/hooks/use-clarifications";
import { submitClarification } from "#/lib/api";
import {
  buildClarificationPayload,
  canSubmit,
  wizardReducer,
  type WizardState,
} from "#/lib/chat/clarification-wizard";

const INITIAL_WIZARD: WizardState = { step: 0, answers: {}, skipped: [] };

/**
 * Glass clarification card rendered above the composer while the agent's
 * request_clarification tool waits for answers. Pending requests come from
 * the run's stream events via useClarifications (the approvals panel's data
 * source, mirrored); answers go straight to api.ts submitClarification.
 */
export function ClarificationPanel() {
  const chat = useChatContext();
  const { pending, dismiss } = useClarifications(chat);
  const [wizard, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);

  const active = pending[0];

  useEffect(() => {
    dispatch({ type: "reset" });
    setSubmitting(false);
    setSubmitError(false);
  }, [active?.id]);

  if (!active) return null;

  const questions = active.questions;
  const lastStep = questions.length - 1;
  const isLastStep = wizard.step >= lastStep;
  const current = questions[Math.min(wizard.step, lastStep)];

  const skipCurrent = () => {
    if (current.optional !== true || submitting) return;
    dispatch({ type: "skip", questionId: current.id });
    if (!isLastStep) {
      dispatch({ type: "next", questionsLength: questions.length });
    }
  };

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setSubmitError(false);
    try {
      const body = buildClarificationPayload(wizard, questions);
      await submitClarification({ clarificationId: active.id, body });
      dismiss(active.id);
    } catch {
      setSubmitError(true);
    } finally {
      setSubmitting(false);
    }
  };

  const handleNext = () => {
    dispatch({ type: "next", questionsLength: questions.length });
  };

  return (
    <div className="mb-2 w-full animate-fade-in">
      <div
        className="glass rounded-xl border border-accent/25 px-3 py-2.5"
        role="region"
        aria-label="Clarification"
      >
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate text-xs font-semibold tracking-tight text-text">
            {active.title ?? "Clarification needed"}
          </p>
          <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
            {questions.length > 1
              ? `Pertanyaan ${wizard.step + 1} dari ${questions.length}`
              : "1 pertanyaan"}
          </span>
        </div>

        <div className="mt-2 flex items-center gap-1.5">
          {questions.map((question, index) => (
            <span
              key={question.id}
              className={
                index < wizard.step
                  ? "h-1 w-5 rounded-full bg-accent/60 transition-colors"
                  : index === wizard.step
                    ? "h-1 w-5 rounded-full bg-accent"
                    : "h-1 w-5 rounded-full bg-white/[0.1]"
              }
            />
          ))}
        </div>

        <p className="mt-2.5 text-[12px] leading-relaxed text-text/90">
          {current.question}
        </p>

        {current.type === "single_choice" ? (
          <div
            role="radiogroup"
            aria-label={current.question}
            className="mt-2 flex flex-wrap gap-1.5"
          >
            {(current.options ?? []).map((option) => {
              const selected = wizard.answers[current.id] === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={submitting}
                  onClick={() =>
                    dispatch({
                      type: "answer",
                      questionId: current.id,
                      value: option.id,
                    })
                  }
                  className={
                    selected
                      ? "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 text-[11px] font-medium text-accent transition duration-150 hover:bg-accent/15 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                      : "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 text-[11px] font-medium text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                  }
                >
                  <span className="max-w-[180px] truncate">{option.label}</span>
                  {option.recommended ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-accent/15 px-1.5 py-px text-[9px] font-semibold text-accent">
                      <Sparkles className="size-2.5" strokeWidth={2} />
                      Recommended
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {current.type === "multiple_choice" ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(current.options ?? []).map((option) => {
              const selected = (
                (wizard.answers[current.id] as string[] | undefined) ?? []
              ).includes(option.id);
              const toggle = () => {
                const currentValue = (
                  (wizard.answers[current.id] as string[] | undefined) ?? []
                ).slice();
                const next = selected
                  ? currentValue.filter((id) => id !== option.id)
                  : [...currentValue, option.id];
                dispatch({
                  type: "answer",
                  questionId: current.id,
                  value: next,
                });
              };
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={selected}
                  disabled={submitting}
                  onClick={toggle}
                  className={
                    selected
                      ? "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 text-[11px] font-medium text-accent transition duration-150 hover:bg-accent/15 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                      : "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 text-[11px] font-medium text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                  }
                >
                  {selected ? (
                    <Check className="size-3 shrink-0" strokeWidth={2.5} />
                  ) : null}
                  <span className="max-w-[180px] truncate">{option.label}</span>
                  {option.recommended ? (
                    <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-accent/15 px-1.5 py-px text-[9px] font-semibold text-accent">
                      <Sparkles className="size-2.5" strokeWidth={2} />
                      Recommended
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        {current.type === "free_text" ? (
          <input
            type="text"
            value={(wizard.answers[current.id] as string | undefined) ?? ""}
            onChange={(event) =>
              dispatch({
                type: "answer",
                questionId: current.id,
                value: event.target.value,
              })
            }
            disabled={submitting}
            placeholder={current.placeholder ?? "Type your answer…"}
            aria-label={current.question}
            className="mt-2 w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-text placeholder:text-text-faint outline-none ring-accent-ring focus:border-accent/40 focus:ring-2 disabled:opacity-40"
          />
        ) : null}

        <div className="mt-2.5 flex items-center justify-between gap-1.5">
          <button
            type="button"
            disabled={wizard.step === 0 || submitting}
            onClick={() => dispatch({ type: "back" })}
            className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg bg-white/[0.06] px-2.5 text-[11px] font-medium text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="size-3.5" strokeWidth={2} />
            Back
          </button>

          <div className="flex items-center gap-1.5">
            {current.optional === true && !isLastStep ? (
              <button
                type="button"
                disabled={submitting}
                onClick={skipCurrent}
                className="inline-flex h-7 shrink-0 cursor-pointer items-center rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 text-[11px] font-medium text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Skip
              </button>
            ) : null}

            {isLastStep ? (
              <button
                type="button"
                disabled={submitting || !canSubmit(wizard, questions)}
                onClick={() => void submit()}
                className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[11px] font-semibold text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-150 hover:bg-accent-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {submitting ? (
                  <Loader2 className="size-3 animate-spin" strokeWidth={2} />
                ) : (
                  <Check className="size-3" strokeWidth={2.5} />
                )}
                {submitting ? "Sending…" : "Submit"}
              </button>
            ) : (
              <button
                type="button"
                disabled={submitting}
                onClick={handleNext}
                className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg bg-accent px-2.5 text-[11px] font-semibold text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-150 hover:bg-accent-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
                <ChevronRight className="size-3.5" strokeWidth={2} />
              </button>
            )}
          </div>
        </div>

        {submitError ? (
          <p aria-live="polite" className="mt-1.5 text-[10px] text-danger">
            Couldn't send your answers — try again.
          </p>
        ) : null}
      </div>
    </div>
  );
}

import type { ClientInteraction } from "@anvia/client";
import type {
  AgentToolQuestionRequest,
  AgentInteractionResponse,
} from "@anvia/core/agent/interactions";
import { useChatContext } from "@anvia/react-ui";
import { Check, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  buildQuestionResponse,
  stageThenRespond,
} from "#/lib/chat/interaction-response";

type QuestionInteraction = ClientInteraction & {
  request: AgentToolQuestionRequest;
};

function isQuestionInteraction(
  interaction: ClientInteraction,
): interaction is QuestionInteraction {
  return interaction.request.type === "tool-question";
}

/** Native v1 question cards; one submission answers every required prompt. */
export function ClarificationPanel({
  onInteractionSettled,
}: {
  onInteractionSettled?: () => Promise<void>;
}) {
  const chat = useChatContext();
  const pending = chat.interactions.pending.filter(isQuestionInteraction);
  if (pending.length === 0) return null;

  return (
    <div className="mb-2 flex w-full flex-col gap-2">
      {pending.map((interaction) => (
        <QuestionCard
          key={interaction.request.id}
          interaction={interaction}
          respondingInteractions={chat.respondingInteractions}
          respond={chat.respondToInteraction}
          onInteractionSettled={onInteractionSettled}
        />
      ))}
    </div>
  );
}

function QuestionCard({
  interaction,
  respondingInteractions,
  respond,
  onInteractionSettled,
}: {
  interaction: QuestionInteraction;
  respondingInteractions: ReadonlySet<string>;
  respond: (input: {
    interactionId: string;
    response: AgentInteractionResponse;
  }) => Promise<void>;
  onInteractionSettled?: () => Promise<void>;
}) {
  const request = interaction.request;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [validationAttempted, setValidationAttempted] = useState(false);
  const inFlight = useRef(new Set<string>());
  const responding = submitting || respondingInteractions.has(request.id);

  useEffect(() => {
    setAnswers({});
    setSubmitting(false);
    setSubmitError(null);
    setValidationAttempted(false);
  }, [request.id]);

  const setAnswer = (questionId: string, value: string) => {
    setAnswers((current) => ({ ...current, [questionId]: value }));
    setSubmitError(null);
  };

  const submit = async () => {
    setValidationAttempted(true);
    const hasMissingAnswer = request.questions.some(
      (question) => (answers[question.id] ?? "").trim().length === 0,
    );
    if (responding || inFlight.current.has(request.id) || hasMissingAnswer) {
      if (!responding && hasMissingAnswer) {
        setSubmitError("Answer every question before submitting.");
      }
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = buildQuestionResponse({
        request,
        answers: request.questions.map((question) => ({
          questionId: question.id,
          value: answers[question.id]!.trim(),
        })),
      });
      await stageThenRespond({
        interaction,
        response,
        respond,
        respondingInteractions,
        inFlight: inFlight.current,
      });
      await onInteractionSettled?.();
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : "Interaction response could not be sent. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="glass rounded-xl border border-accent/25 px-3 py-2.5 animate-fade-in"
      role="region"
      aria-label="Question"
      aria-busy={responding}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-semibold tracking-tight text-text">
          Clarification needed
        </p>
        <span className="shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent">
          {request.questions.length} {request.questions.length === 1 ? "question" : "questions"}
        </span>
      </div>

      <div className="mt-2.5 flex flex-col gap-3">
        {request.questions.map((question) => {
          const value = answers[question.id] ?? "";
          const fieldInvalid =
            validationAttempted && value.trim().length === 0;
          const promptId = questionDomId(request.id, question.id, "prompt");
          const errorId = questionDomId(request.id, question.id, "error");
          const describedBy = fieldInvalid
            ? `${promptId} ${errorId}`
            : promptId;
          const showTextInput =
            question.choices === undefined || question.allowCustom === true;
          return (
            <div key={question.id} className="flex flex-col gap-1.5">
              <p id={promptId} className="text-[12px] leading-relaxed text-text/90">
                {question.text}
              </p>
              {question.choices ? (
                <div
                  role="radiogroup"
                  aria-labelledby={promptId}
                  aria-required="true"
                  aria-invalid={fieldInvalid || undefined}
                  aria-describedby={describedBy}
                  className="flex flex-wrap gap-1.5"
                >
                  {question.choices.map((choice) => {
                    const selected = value === choice.value;
                    return (
                      <button
                        key={choice.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-describedby={promptId}
                        disabled={responding}
                        onClick={() => setAnswer(question.id, choice.value)}
                        className={
                          selected
                            ? "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 text-[11px] font-medium text-accent transition duration-150 hover:bg-accent/15 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                            : "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 text-[11px] font-medium text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                        }
                      >
                        {selected ? <Check className="size-3" strokeWidth={2.5} /> : null}
                        <span className="max-w-[220px] truncate">{choice.label}</span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {showTextInput ? (
                <input
                  type="text"
                  value={value}
                  onChange={(event) => setAnswer(question.id, event.target.value)}
                  disabled={responding}
                  aria-label={question.text}
                  aria-required="true"
                  aria-invalid={fieldInvalid || undefined}
                  aria-describedby={describedBy}
                  className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] leading-relaxed text-text placeholder:text-text-faint outline-none ring-accent-ring focus:border-accent/40 focus:ring-2 disabled:opacity-40"
                />
              ) : null}
              {fieldInvalid ? (
                <p id={errorId} role="alert" className="text-[10px] text-danger">
                  Answer required.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="mt-2.5 flex items-center justify-end">
        <button
          type="button"
          disabled={responding}
          aria-describedby={submitError ? submitErrorId(request.id) : undefined}
          onClick={() => void submit()}
          className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-2.5 text-[11px] font-semibold text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-150 hover:bg-accent-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? <Loader2 className="size-3 animate-spin" strokeWidth={2} /> : <Check className="size-3" strokeWidth={2.5} />}
          {submitting ? "Sending…" : "Submit"}
        </button>
      </div>

      {submitError ? (
        <p
          id={submitErrorId(request.id)}
          role="alert"
          aria-live="assertive"
          className="mt-1.5 text-[10px] text-danger"
        >
          {submitError}
        </p>
      ) : null}
    </div>
  );
}

function questionDomId(
  interactionId: string,
  questionId: string,
  suffix: string,
): string {
  return `native-question-${domIdPart(interactionId)}-${domIdPart(questionId)}-${suffix}`;
}

function submitErrorId(interactionId: string): string {
  return `native-question-${domIdPart(interactionId)}-submit-error`;
}

function domIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

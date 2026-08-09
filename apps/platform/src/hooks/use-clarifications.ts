import { useCallback, useEffect, useRef, useState } from "react";

export type ClarificationOption = {
  id: string;
  label: string;
  recommended?: boolean;
};

export type ClarificationQuestion = {
  id: string;
  question: string;
  type: "single_choice" | "multiple_choice" | "free_text";
  options?: ClarificationOption[];
  optional?: boolean;
  placeholder?: string;
};

export type ClarificationRecord = {
  id: string;
  sessionId: string;
  title?: string;
  questions: ClarificationQuestion[];
  requestedAt: string;
};

type ClarificationChat = {
  events: unknown[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isClarificationOption(value: unknown): value is ClarificationOption {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.recommended === undefined || typeof value.recommended === "boolean")
  );
}

function isClarificationQuestion(
  value: unknown,
): value is ClarificationQuestion {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.question !== "string" ||
    (value.type !== "single_choice" &&
      value.type !== "multiple_choice" &&
      value.type !== "free_text")
  ) {
    return false;
  }
  if (value.options !== undefined && !Array.isArray(value.options)) {
    return false;
  }
  if (value.options !== undefined && !value.options.every(isClarificationOption)) {
    return false;
  }
  return true;
}

function parseRequestEvent(event: unknown): ClarificationRecord | null {
  if (!isRecord(event) || event.type !== "clarification_request") return null;
  const clarification = event.clarification;
  if (
    !isRecord(clarification) ||
    typeof clarification.id !== "string" ||
    typeof clarification.sessionId !== "string" ||
    !Array.isArray(clarification.questions) ||
    clarification.questions.length === 0 ||
    !clarification.questions.every(isClarificationQuestion)
  ) {
    return null;
  }
  return {
    id: clarification.id,
    sessionId: clarification.sessionId,
    ...(typeof clarification.title === "string" && clarification.title
      ? { title: clarification.title }
      : {}),
    questions: clarification.questions,
    requestedAt:
      typeof clarification.requestedAt === "string"
        ? clarification.requestedAt
        : "",
  };
}

function parseResponseId(event: unknown): string | null {
  if (!isRecord(event) || event.type !== "clarification_response") {
    return null;
  }
  const clarification = event.clarification;
  if (!isRecord(clarification) || typeof clarification.id !== "string") {
    return null;
  }
  return clarification.id;
}

/**
 * Pending clarification requests from the current run's stream events.
 * `useChat` appends every unwrapped transport event to `chat.events` (and
 * clears it per send), so this mirrors the approvals channel's data source
 * while keeping the full clarification schema (types, recommended, optional).
 */
export function useClarifications(chat: ClarificationChat): {
  pending: ClarificationRecord[];
  dismiss: (id: string) => void;
} {
  const [pending, setPending] = useState<ClarificationRecord[]>([]);
  const lastIndexRef = useRef(0);

  const dismiss = useCallback((id: string) => {
    setPending((current) => current.filter((item) => item.id !== id));
  }, []);

  useEffect(() => {
    const events = chat.events;
    if (events.length === 0) {
      lastIndexRef.current = 0;
      setPending([]);
      return;
    }
    let requests: ClarificationRecord[] | null = null;
    let responseIds: string[] | null = null;
    for (let i = lastIndexRef.current; i < events.length; i++) {
      const request = parseRequestEvent(events[i]);
      if (request !== null) {
        (requests ??= []).push(request);
        continue;
      }
      const responseId = parseResponseId(events[i]);
      if (responseId !== null) {
        (responseIds ??= []).push(responseId);
      }
    }
    lastIndexRef.current = events.length;
    if (requests !== null || responseIds !== null) {
      setPending((current) => {
        let next = current;
        for (const request of requests ?? []) {
          next = next.filter((item) => item.id !== request.id);
          next = [...next, request];
        }
        if (responseIds !== null) {
          const removed = new Set(responseIds);
          next = next.filter((item) => !removed.has(item.id));
        }
        return next;
      });
    }
  }, [chat.events]);

  return { pending, dismiss };
}

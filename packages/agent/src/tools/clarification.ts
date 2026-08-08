import { createTool } from "@anvia/core";
import z from "zod";

export const MAX_CLARIFICATION_QUESTIONS = 5;

export type ClarificationResponse = {
  answers: Record<string, string | string[]>;
  skipped: string[];
  timedOut: boolean;
};

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  recommended: z.boolean().optional(),
});

const questionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1).max(2000),
    type: z.enum(["single_choice", "multiple_choice", "free_text"]),
    options: z.array(optionSchema).min(2).max(8).optional(),
    optional: z.boolean().optional(),
    placeholder: z.string().max(200).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.type !== "free_text" && !q.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "choice questions require options",
        path: ["options"],
      });
    }
    if (q.type === "free_text" && q.options) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "free_text must not have options",
        path: ["options"],
      });
    }
  });

const clarificationInput = z.object({
  title: z.string().min(1).max(120).optional(),
  questions: z.array(questionSchema).min(1).max(MAX_CLARIFICATION_QUESTIONS),
});

export type ClarificationOption = z.output<typeof optionSchema>;
export type ClarificationQuestion = z.output<typeof questionSchema>;
export type ClarificationRequest = z.output<typeof clarificationInput>;

export type ClarificationToolScope = {
  requester: (request: ClarificationRequest) => Promise<ClarificationResponse>;
};

export function createClarificationTool(scope: ClarificationToolScope) {
  return createTool({
    name: "request_clarification",
    description:
      "Ask the user to clarify an uncertain request before acting. Use when the user's request is ambiguous (style, dimensions, subject, scope) or when choosing between valid options would materially change the result. You may ask up to 5 questions at once; mark recommended choices and mark optional questions you can answer yourself via the recommended choice.",
    input: clarificationInput,
    execute: async (args) => {
      const response = await scope.requester(args);
      return {
        status: response.timedOut ? "timed_out" : "answered",
        answers: response.answers,
        skipped: response.skipped,
        note: response.timedOut
          ? "The user did not respond in time; proceed using the recommended choices and your best judgment."
          : "Use the answers above; for skipped questions use the recommended choice or your best default.",
      };
    },
  });
}

export const CLARIFICATION_INSTRUCTION = [
  "You have a request_clarification tool to ask the user before acting on uncertain requests.",
  "Call it when the user's request is ambiguous: missing style, aspect ratio, subject details, or when your chosen defaults would significantly change the outcome.",
  "For every choice question mark the option you recommend; mark questions optional only if you can confidently fall back to your recommended choice.",
  "Wait for the user's answers; honor them exactly. For skipped questions use the recommended choice.",
  "Do not use request_clarification for permission — permission is handled automatically by the system.",
].join("\n");

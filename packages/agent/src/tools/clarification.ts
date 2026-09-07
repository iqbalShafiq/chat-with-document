import { createQuestionTool } from "@anvia/core/tool";
import type { ToolDefinition } from "@anvia/core";

const clarificationSpec = {
  name: "request_clarification",
  description:
    "Ask the user for required information before acting. Ask only questions whose answers materially change the result. Each question must accept one required answer, optionally constrained to choices with custom text allowed when appropriate.",
} as const;

export const CLARIFICATION_TOOL_DEFINITIONS: ToolDefinition[] = [
  createQuestionTool(clarificationSpec).definition("") as ToolDefinition,
];

export function createClarificationTool() {
  return createQuestionTool(clarificationSpec);
}

export const CLARIFICATION_INSTRUCTION = [
  "You have a request_clarification tool to ask the user before acting on uncertain requests.",
  "Call it only when missing information would materially change the outcome; do not ask merely to restate a concrete request.",
  "Use choices for one bounded selection and allow custom text when the listed choices may be incomplete.",
  "Every question requires exactly one answer. After the interaction resumes, honor every answer exactly.",
  "Do not use request_clarification for permission — permission is handled automatically by the system.",
].join("\n");

import { stripCitationsForCopy } from "#/lib/chat/citations";

export type ContextSnippetSourceRole = "user" | "assistant";

export const MAX_CONTEXT_SNIPPET_CHARS = 2000;

/**
 * Shared normalization for text added as context (selection or reply icon):
 * strip citation markers for assistant text, collapse whitespace, cap length.
 * Returns null when nothing usable remains.
 */
export function normalizeContextText(
  raw: string,
  role: ContextSnippetSourceRole,
): string | null {
  const stripped = role === "assistant" ? stripCitationsForCopy(raw) : raw;
  const collapsed = stripped.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return Array.from(collapsed)
    .slice(0, MAX_CONTEXT_SNIPPET_CHARS)
    .join("");
}

import type { UIMessage } from "@anvia/react";
import { readChatMessageMeta } from "#/lib/chat/message-metadata";
import type { MessageCitation } from "#/lib/chat/citations";

export type CitedDocumentSummary = {
  documentId: string;
  filename: string;
  citationCount: number;
  /** First citation id seen (for focus UX). */
  firstCitationId?: number;
};

/**
 * Collect unique documents cited in assistant message metadata for a session.
 * Prefers dual-written `metadata.citations` over re-parsing message bodies.
 */
export function collectCitedDocuments(
  messages: UIMessage[],
): CitedDocumentSummary[] {
  const byId = new Map<string, CitedDocumentSummary>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const citations = readChatMessageMeta(message.metadata).citations;
    if (!citations || citations.length === 0) continue;

    for (const citation of citations) {
      upsertCitation(byId, citation);
    }
  }

  return [...byId.values()].sort((a, b) => {
    if (b.citationCount !== a.citationCount) {
      return b.citationCount - a.citationCount;
    }
    return a.filename.localeCompare(b.filename);
  });
}

function upsertCitation(
  byId: Map<string, CitedDocumentSummary>,
  citation: MessageCitation,
) {
  const documentId = citation.documentId?.trim();
  if (!documentId) return;

  const filename =
    citation.filename?.trim() || documentId;

  const existing = byId.get(documentId);
  if (existing) {
    existing.citationCount += 1;
    if (
      existing.firstCitationId == null &&
      typeof citation.id === "number"
    ) {
      existing.firstCitationId = citation.id;
    }
    // Prefer a real filename over raw id if a later citation has one.
    if (
      existing.filename === documentId &&
      filename !== documentId
    ) {
      existing.filename = filename;
    }
    return;
  }

  byId.set(documentId, {
    documentId,
    filename,
    citationCount: 1,
    ...(typeof citation.id === "number"
      ? { firstCitationId: citation.id }
      : {}),
  });
}

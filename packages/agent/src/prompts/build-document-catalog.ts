export interface SessionDocumentCatalogEntry {
  id: string;
  filename: string;
  firstPageSummary: string;
}

export function buildDocumentCatalogInstruction(
  documents: SessionDocumentCatalogEntry[],
) {
  if (documents.length === 0) {
    return `Session documents:
(none active in this session)

Important:
- There are **no active documents** linked to this chat right now.
- Document tools (find_documents, search_document_pages, get_document_next_page, get_document_page_images) are **not available**.
- Do **not** invent document ids, page numbers, or citations from earlier turns.
- Prior conversation may mention documents that were since unlinked — treat that as history only; you cannot retrieve their content unless the user re-adds them.
- Answer from general knowledge, or ask the user to attach/link documents if the question requires source material.`;
  }

  const lines = documents.map(
    (doc) =>
      `- [${doc.filename}] id=${doc.id} | page1: ${doc.firstPageSummary || "(empty)"}`,
  );

  return `Session documents (current session only):
${lines.join("\n")}

When answering about uploaded documents:
1. Use the document id from this catalog when possible.
2. If the relevant document is unclear, call find_documents.
3. Use search_document_pages for semantic retrieval.
4. If the answer depends on visual content (charts, photos, diagrams), call get_document_page_images for the relevant page.
5. If a page seems incomplete, call get_document_next_page.
6. Ground claims with [[cite:N]] markers and a trailing \`\`\`citations JSON block (see citation instructions). Never invent ids or pages.
7. Only use ids from this catalog — ignore documents that are not listed (e.g. unlinked from the session).`;
}

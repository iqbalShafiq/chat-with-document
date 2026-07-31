export interface SessionDocumentCatalogEntry {
  id: string;
  filename: string;
  firstPageSummary: string;
}

export function buildDocumentCatalogInstruction(
  documents: SessionDocumentCatalogEntry[],
) {
  if (documents.length === 0) {
    return `Session documents:\n(none uploaded yet)`;
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
4. If a page seems incomplete, call get_document_next_page.
5. Ground claims with [[cite:N]] markers and a trailing \`\`\`citations JSON block (see citation instructions). Never invent ids or pages.`;
}

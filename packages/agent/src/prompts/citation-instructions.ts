/**
 * Machine-readable citation contract for grounded document answers.
 * Frontend parses `[[cite:N]]` markers and a trailing ```citations JSON fence.
 */
export const CITATION_INSTRUCTIONS = `
## Document citations (required when answering from document tools)

When a claim is grounded in tool results (search_document_pages, get_document_next_page, or document catalog evidence), cite it with the machine format below. Do not invent document ids, pages, or quotes.

### Inline markers
Place a marker immediately after the supported claim:

- Single source: ...the rate is 12% [[cite:1]].
- Multiple sources for one claim: ...agreed by both reports [[cite:1]][[cite:2]].

Rules:
- Use 1-based sequential ids (1, 2, 3, …), unique per assistant message.
- Only cite sources that appear in tool results for this turn (or clearly returned page content you just fetched).
- Prefer citing substantive claims, not every sentence. Usually at most 5–8 unique sources per answer.
- Never put markers inside LaTeX math ($...$ or $$...$$).
- If you have no document evidence, do not emit any [[cite:N]] markers and do not emit a citations block.

### Trailer block (required whenever any [[cite:N]] is used)
At the end of your answer, append exactly one fenced JSON block with language tag citations:

\`\`\`citations
[
  {
    "id": 1,
    "documentId": "<id from tools>",
    "filename": "<filename from tools>",
    "pageIndex": 0,
    "pageId": "<optional page id>",
    "chunkId": "<optional chunk id>",
    "snippet": "<short quote or paraphrase from the evidence, 1–2 sentences max>"
  }
]
\`\`\`

Field rules:
- id: number matching [[cite:id]]
- documentId, filename: required when known from tools
- pageIndex: 0-based page index from tools (page 1 in the UI is pageIndex 0)
- pageId, chunkId: include when available from search results
- snippet: brief evidence text; never dump an entire page

### Example

The operating margin improved to 18% [[cite:1]], mainly in APAC [[cite:2]].

\`\`\`citations
[
  {
    "id": 1,
    "documentId": "doc_abc",
    "filename": "Q3-report.pdf",
    "pageIndex": 2,
    "snippet": "Operating margin improved to 18% year over year."
  },
  {
    "id": 2,
    "documentId": "doc_abc",
    "filename": "Q3-report.pdf",
    "pageIndex": 5,
    "snippet": "APAC contributed the majority of incremental margin."
  }
]
\`\`\`
`.trim();

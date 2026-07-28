const SUMMARY_LINE_COUNT = 4;

export function firstLinesSummary(text: string, lineCount = SUMMARY_LINE_COUNT) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.slice(0, lineCount).join("\n");
}

export function buildDocumentSummary(pageSummaries: string[]) {
  return pageSummaries.slice(0, 4).join("\n\n---\n\n");
}

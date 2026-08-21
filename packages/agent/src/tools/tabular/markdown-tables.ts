export type MarkdownTable = { columns: string[]; rows: string[][] };

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

export function extractMarkdownTables(markdown: string): MarkdownTable[] {
  const tables: MarkdownTable[] = [];
  const lines = markdown.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (TABLE_ROW.test(lines[i]!)) {
      const start = i;
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) i += 1;
      const block = lines.slice(start, i);
      const cells = (line: string) =>
        line
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim());
      const header = cells(block[0]!);
      if (block.length < 2 || !SEPARATOR.test(block[1]!)) continue;
      const rows = block
        .slice(2)
        .map(cells)
        .filter((row) => row.some((cell) => cell !== ""));
      if (header.some((cell) => cell !== "")) tables.push({ columns: header, rows });
    } else {
      i += 1;
    }
  }
  return tables;
}
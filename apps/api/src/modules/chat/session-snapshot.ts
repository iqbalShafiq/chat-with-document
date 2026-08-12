/** Bounded snapshot of the session's user messages (profile reconsideration input). */
export const SNAPSHOT_MAX_MESSAGES = 12;
export const SNAPSHOT_MAX_CHARS = 8000;

export function buildSessionSnapshotText(
  rows: Array<{ createdAt: Date; text: string }>,
): string {
  const candidates = rows
    .map((row) => ({
      createdAt: row.createdAt,
      text: row.text.replace(/\s+/g, " ").trim(),
    }))
    .filter((row) => row.text.length > 0);
  const parts: string[] = [];
  let used = 0;
  for (const row of candidates.slice(-SNAPSHOT_MAX_MESSAGES)) {
    const prefix = `[${row.createdAt.toISOString()}] `;
    const sep = parts.length > 0 ? 1 : 0;
    const budget = SNAPSHOT_MAX_CHARS - used - prefix.length - sep;
    if (budget <= 0) break;
    const chars = Array.from(row.text);
    const clipped =
      chars.length > budget ? `${chars.slice(0, budget - 1).join("")}…` : row.text;
    parts.push(`${prefix}${clipped}`);
    used += prefix.length + clipped.length + sep;
  }
  return parts.join("\n");
}

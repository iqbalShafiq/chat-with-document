/** Bounded snapshot of the session's user messages (profile reconsideration input). */
export const SNAPSHOT_MAX_MESSAGES = 12;
export const SNAPSHOT_MAX_CHARS = 8000;

/** Clip to a UTF-16-unit budget, never splitting a surrogate pair. */
function clipToUtf16Budget(text: string, budget: number): string {
  if (text.length <= budget) return text;
  let kept = "";
  for (const ch of text) {
    if (kept.length + ch.length > budget - 1) break;
    kept += ch;
  }
  return `${kept}…`;
}

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
  const newest = candidates.slice(-SNAPSHOT_MAX_MESSAGES);
  for (let i = newest.length - 1; i >= 0; i--) {
    const row = newest[i];
    const prefix = `[${row.createdAt.toISOString()}] `;
    const sep = parts.length > 0 ? 1 : 0;
    const budget = SNAPSHOT_MAX_CHARS - used - prefix.length - sep;
    if (budget <= 0) break;
    const clipped = clipToUtf16Budget(row.text, budget);
    parts.push(`${prefix}${clipped}`);
    used += prefix.length + clipped.length + sep;
  }
  return parts.reverse().join("\n");
}

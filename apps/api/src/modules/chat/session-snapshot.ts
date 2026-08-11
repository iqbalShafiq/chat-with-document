/** Bounded snapshot of the session's user messages (profile reconsideration input). */
export const SNAPSHOT_MAX_MESSAGES = 12;
export const SNAPSHOT_MAX_CHARS = 8000;

export function buildSessionSnapshotText(
  rows: Array<{ createdAt: Date; text: string }>,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const row of rows.slice(-SNAPSHOT_MAX_MESSAGES)) {
    const text = row.text.trim();
    if (!text) continue;
    const prefix = `[${row.createdAt.toISOString()}] `;
    const budget = SNAPSHOT_MAX_CHARS - used - prefix.length;
    if (budget <= 0) break;
    const clipped = text.length > budget ? `${text.slice(0, budget - 1)}…` : text;
    parts.push(`${prefix}${clipped}`);
    used += prefix.length + clipped.length;
  }
  return parts.join("\n");
}

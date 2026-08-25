export type SessionFreshness = "fresh" | "stale" | "unknown";

export function sessionFreshnessFromCount(
  serverCount: number,
  localCount: number,
): Exclude<SessionFreshness, "unknown"> {
  if (!Number.isFinite(serverCount) || serverCount < 0 || !Number.isInteger(serverCount)) {
    throw new Error("session message count is invalid");
  }
  if (!Number.isFinite(localCount) || localCount < 0 || !Number.isInteger(localCount)) {
    throw new Error("local message count is invalid");
  }
  return serverCount > localCount ? "stale" : "fresh";
}

/**
 * Truncate, regenerate, and resubmit delete newer server memory. They must
 * not proceed unless this view is proven current.
 */
export function blocksDestructiveSessionAction(
  freshness: SessionFreshness,
): boolean {
  return freshness !== "fresh";
}

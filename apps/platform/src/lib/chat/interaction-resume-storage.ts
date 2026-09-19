export const CHAT_RESUME_STORAGE_PREFIX = "anvia:chat-resume:";

export function chatResumeStorageKey(sessionId: string): string {
  return `${CHAT_RESUME_STORAGE_PREFIX}${sessionId}`;
}

function hasPendingNativeInteraction(raw: string | null): boolean {
  if (raw === null || raw.length > 5_000_000) return false;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      record.version === 3 &&
      Array.isArray(record.interactions) &&
      record.interactions.some(
        (interaction) =>
          typeof interaction === "object" &&
          interaction !== null &&
          !Array.isArray(interaction) &&
          (interaction as Record<string, unknown>).status === "pending",
      )
    );
  } catch {
    return false;
  }
}

/**
 * Anvia v1 clears its ordinary resume cursor at every terminal stream frame,
 * including a suspended interaction. Retain that already-validated native
 * snapshot until the interaction is accepted and persisted as responded.
 */
export function createInteractionResumeStorage(backing: Storage): Storage {
  return {
    get length() {
      return backing.length;
    },
    clear: () => backing.clear(),
    getItem: (key) => backing.getItem(key),
    key: (index) => backing.key(index),
    removeItem: (key) => {
      if (hasPendingNativeInteraction(backing.getItem(key))) return;
      backing.removeItem(key);
    },
    setItem: (key, value) => backing.setItem(key, value),
  };
}

export function peekPendingResumeInteractionIds(
  storage: Storage,
  sessionId: string,
): string[] {
  return peekPendingInteractions(storage, sessionId).map((item) => item.id);
}

/**
 * Tool names of approvals that are still waiting for the user.
 *
 * A suspended approval ends its stream, so those tools have no result in
 * memory yet; callers need their names to avoid treating a pending prompt as a
 * stopped tool.
 */
export function peekPendingApprovalToolNames(
  storage: Storage,
  sessionId: string,
): string[] {
  const names = new Set<string>();
  for (const item of peekPendingInteractions(storage, sessionId)) {
    if (item.type === "tool-approval" && item.toolName) names.add(item.toolName);
  }
  return [...names];
}

function peekPendingInteractions(
  storage: Storage,
  sessionId: string,
): { id: string; type: string | null; toolName: string | null }[] {
  const raw = storage.getItem(chatResumeStorageKey(sessionId));
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      (value as { version?: unknown }).version !== 3 ||
      !Array.isArray((value as { interactions?: unknown }).interactions)
    ) {
      return [];
    }
    const items: { id: string; type: string | null; toolName: string | null }[] = [];
    for (const entry of (value as { interactions: unknown[] }).interactions) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as {
        status?: unknown;
        request?: { id?: unknown; type?: unknown; toolName?: unknown };
      };
      if (record.status !== "pending") continue;
      if (typeof record.request?.id !== "string" || record.request.id.length === 0) {
        continue;
      }
      items.push({
        id: record.request.id,
        type: typeof record.request.type === "string" ? record.request.type : null,
        toolName:
          typeof record.request.toolName === "string" && record.request.toolName.length > 0
            ? record.request.toolName
            : null,
      });
    }
    return items;
  } catch {
    return [];
  }
}

/** Bypass the pending-interaction retain wrapper and drop a stale snapshot. */
export function discardChatResumeSnapshot(
  storage: Storage,
  sessionId: string,
): void {
  storage.removeItem(chatResumeStorageKey(sessionId));
}

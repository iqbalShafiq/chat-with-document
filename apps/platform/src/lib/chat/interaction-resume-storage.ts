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

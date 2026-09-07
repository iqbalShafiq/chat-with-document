import { createMemoryScopeKey } from "@anvia/core/memory";

/**
 * Keep one application boundary for the authenticated memory scope while
 * delegating the actual bytes to Anvia v1. Metadata, model ids, projects, and
 * run ids are intentionally not part of the default key.
 */
export function createDefaultMemoryScopeKey(
  sessionId: string,
  userId?: string | null,
): string {
  return createMemoryScopeKey({
    scope: {
      sessionId,
      ...(userId === undefined || userId === null ? {} : { userId }),
    },
  });
}

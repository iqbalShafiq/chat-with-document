/**
 * Mirrors @anvia/memory-prisma default scope key:
 * JSON.stringify([sessionId, userId ?? null]) with includeUserId: true.
 * Keep in sync if the agent memory store is constructed with custom scope options.
 */
export function createDefaultMemoryScopeKey(sessionId: string, userId?: string | null): string {
  return JSON.stringify([sessionId, userId ?? null]);
}

import { prisma } from "../../utils/prisma.js";

/**
 * DB-backed session→project resolver for site scope backfill. Lives outside
 * the (disk-only) static-sites service so that module stays unit-testable.
 */
export async function resolveSessionProjectId(sessionId: string): Promise<string | null> {
  const row = await prisma.chatSession.findFirst({
    where: { id: sessionId },
    select: { projectId: true },
  });
  return row?.projectId ?? null;
}

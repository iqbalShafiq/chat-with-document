import { enqueueProfileRefresh } from "./queue.js";
import { profileConfig } from "./service.js";

/**
 * AsyncIterable tap: after the stream ends (success or error), schedule the
 * profile refresh for the chat's scope. Never throws to the stream consumer.
 */
export async function* tapProfileRefresh<T>(
  source: AsyncIterable<T>,
  ctx: { userId: string; projectId?: string | null },
): AsyncGenerator<T> {
  try {
    for await (const item of source) {
      yield item;
    }
  } finally {
    if (!profileConfig().enabled) return;
    try {
      await enqueueProfileRefresh({ kind: "user", userId: ctx.userId });
      if (ctx.projectId) {
        await enqueueProfileRefresh({
          kind: "project",
          userId: ctx.userId,
          projectId: ctx.projectId,
        });
      }
    } catch (error) {
      console.error("[profile] enqueue after stream failed", error);
    }
  }
}

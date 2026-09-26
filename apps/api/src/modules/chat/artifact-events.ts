import { getRedis } from "../../lib/redis.js";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { ACTIVE_RUN_KEY } from "./run-queue.js";
import { mapChatAppEvent, toChatResumableEvent } from "./client-events.js";

/**
 * Tell the browser which artifact the agent is pointing at right now.
 * Dismissible UI hint only — never carries bytes, keys, or secrets.
 */
export async function publishArtifactFocus(input: {
  sessionId: string;
  artifactId: string;
  artifactType: "document" | "image" | "web_bundle" | "site" | "task" | "schedule" | "session";
  label?: string;
}): Promise<void> {
  const streamId = await getRedis().get(ACTIVE_RUN_KEY(input.sessionId));
  if (!streamId) return;

  const event = mapChatAppEvent(
    {
      type: "artifact_focus",
      artifactId: input.artifactId,
      artifactType: input.artifactType,
      // Defensive bound: the projection drops labels >200 chars, and a focus
      // hint must never silently disappear because a title was long.
      ...(input.label === undefined ? {} : { label: input.label.slice(0, 200) }),
    },
    { runId: streamId },
  );
  if (!event) return;

  await getStreamStore().append({ streamId, event: toChatResumableEvent(event) });
}

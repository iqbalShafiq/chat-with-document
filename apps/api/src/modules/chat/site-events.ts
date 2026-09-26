import { getRedis } from "../../lib/redis.js";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { ACTIVE_RUN_KEY } from "./run-queue.js";
import { mapChatAppEvent, toChatResumableEvent } from "./client-events.js";

export type SiteBuildPhase =
  | "starting"
  | "planning"
  | "building"
  | "bundling"
  | "preview"
  | "ready"
  | "failed";

export type SiteBuildAppEvent =
  | {
      type: "site_build_progress";
      siteId: string;
      version: number;
      phase: SiteBuildPhase;
      message: string;
    }
  | {
      type: "site_build_ready";
      siteId: string;
      version: number;
      previewUrl: string | null;
      screenshotUrl: string | null;
      downloadUrl: string;
    };

export async function publishSiteBuildEvent(input: {
  sessionId: string;
  appEvent: SiteBuildAppEvent;
}): Promise<void> {
  const streamId = await getRedis().get(ACTIVE_RUN_KEY(input.sessionId));
  if (!streamId) return;

  const event = mapChatAppEvent(
    input.appEvent as unknown as Parameters<typeof mapChatAppEvent>[0],
    { runId: streamId },
  );
  if (!event) return;

  await getStreamStore().append({ streamId, event: toChatResumableEvent(event) });
}

export type SiteLiveViewAppEvent = {
  state: "started" | "stopped";
  siteId: string;
  label?: string;
};

/**
 * Tell the browser that a live browse session started or stopped so the chat
 * can show/hide the frame card. Frames themselves never travel this path.
 */
export async function publishSiteLiveView(
  sessionId: string,
  event: SiteLiveViewAppEvent,
): Promise<void> {
  const streamId = await getRedis().get(ACTIVE_RUN_KEY(sessionId));
  if (!streamId) return;

  const mapped = mapChatAppEvent(
    {
      type: "site_live_view",
      state: event.state,
      siteId: event.siteId,
      ...(event.label === undefined ? {} : { label: event.label.slice(0, 200) }),
    },
    { runId: streamId },
  );
  if (!mapped) return;

  await getStreamStore().append({ streamId, event: toChatResumableEvent(mapped) });
}

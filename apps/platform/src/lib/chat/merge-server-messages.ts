import type { ClientDataMap, ClientMetadata, UIMessage, UIMessagePart } from "@anvia/client";
import { isStillRunningToolOutput } from "#/lib/chat/tool-wait-progress";

type ToolPart = Extract<UIMessagePart, { type: "tool" }>;

function toolParts(message: UIMessage<ClientMetadata, ClientDataMap>): ToolPart[] {
  return message.parts.filter((part): part is ToolPart => part.type === "tool");
}

/**
 * Overlay a reloaded server snapshot onto the messages already on screen.
 *
 * Server memory commits a tool result only after the call settles, so during a
 * live run it lags the browser: a call the user can see waiting is absent from
 * the snapshot. Replacing the transcript wholesale would therefore erase live
 * progress and make in-flight calls look finished-or-stopped. Keep the local
 * part whenever it is ahead of the server, and take the server value once it
 * carries the settled output.
 */
export function mergeServerMessages<
  Metadata extends ClientMetadata = ClientMetadata,
  Data extends ClientDataMap = ClientDataMap,
>(
  server: UIMessage<Metadata, Data>[],
  live: readonly UIMessage<Metadata, Data>[],
): UIMessage<Metadata, Data>[] {
  const liveParts = new Map<string, ToolPart>();
  for (const message of live) {
    for (const part of toolParts(message as UIMessage<ClientMetadata, ClientDataMap>)) {
      liveParts.set(part.toolCallId, part);
    }
  }
  if (liveParts.size === 0) return server;

  let anyChanged = false;
  const merged = server.map((message) => {
    if (message.role !== "assistant") return message;
    let messageChanged = false;
    const parts = message.parts.map((part) => {
      if (part.type !== "tool") return part;
      const local = liveParts.get(part.toolCallId);
      if (!local) return part;
      // The local part is authoritative while it is mid-flight or already
      // settled; the server copy is only ahead when it has a real result and
      // the browser does not.
      const localSettled =
        local.state === "output-available" && !isStillRunningToolOutput(local.output);
      const serverSettled =
        part.state === "output-available" && !isStillRunningToolOutput(part.output);
      if (localSettled || !serverSettled) {
        messageChanged = true;
        return local;
      }
      return part;
    });
    if (!messageChanged) return message;
    anyChanged = true;
    return { ...message, parts };
  });
  return anyChanged ? merged : server;
}
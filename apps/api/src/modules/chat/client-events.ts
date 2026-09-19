import {
  CLIENT_STREAM_PROTOCOL,
  customAgentEventsToClientStream,
  parseClientStreamEvent,
  type AgentClientStreamContext,
  type ClientDataSchemas,
  type ClientStream,
  type ClientStreamEvent,
} from "@anvia/client";
import type { ClientResumableEvent } from "@anvia/server";
import type { AgentInteractionOutcome, AgentStreamEvent } from "@anvia/core/agent";
import { z } from "zod";

const boundedString = (max: number) => z.string().min(1).max(max);
const boundedCount = (max: number) => z.number().int().nonnegative().max(max);

export const ChatMetadataSchema = z.object({
  sessionId: boundedString(200),
  modelId: boundedString(200),
  reasoningEffort: z.string().max(40).nullable(),
}).strict();

const deepResearchActivitySchema = z.object({
  id: boundedString(200),
  kind: z.enum(["planning", "retrieval", "analysis", "verification", "synthesis"]),
  label: boundedString(240),
  status: z.enum(["active", "done", "failed"]),
}).strict();

const deepResearchProgressSchema = z.object({
  phase: z.enum(["planning", "researching", "synthesizing", "completed", "failed"]),
  message: boundedString(4000),
  activities: z.array(deepResearchActivitySchema).max(50).optional(),
  stats: z.object({
    retrievalCalls: boundedCount(100_000),
    retrievalLimit: boundedCount(100_000),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.stats && value.stats.retrievalCalls > value.stats.retrievalLimit) {
    context.addIssue({ code: "custom", path: ["stats", "retrievalCalls"], message: "retrievalCalls exceeds retrievalLimit" });
  }
});

const queuedMessageAppliedSchema = z.object({
  clientMessageId: boundedString(200),
  attachmentCount: boundedCount(100),
}).strict();

const toolWaitProgressSchema = z.object({
  toolCallId: boundedString(200),
  toolName: boundedString(200),
  phase: z.enum(["running", "wait_elapsed", "awaiting", "cancelled", "completed", "failed"]),
  elapsedMs: boundedCount(86_400_000),
  waitCount: boundedCount(10_000),
  stage: boundedString(240).optional(),
}).strict();

const deepResearchAppEventSchema = z.object({
  type: z.literal("deep_research_progress"),
  phase: deepResearchProgressSchema.shape.phase,
  message: deepResearchProgressSchema.shape.message,
  activities: deepResearchProgressSchema.shape.activities,
  stats: deepResearchProgressSchema.shape.stats,
}).strict();
const queuedMessageAppEventSchema = z.object({
  type: z.literal("queued_message_applied"),
  clientMessageId: queuedMessageAppliedSchema.shape.clientMessageId,
  text: z.string().max(8_000).optional(),
  attachmentCount: queuedMessageAppliedSchema.shape.attachmentCount,
}).strict();
const toolWaitProgressAppEventSchema = z.object({
  type: z.literal("tool_wait_progress"),
  toolCallId: toolWaitProgressSchema.shape.toolCallId,
  toolName: toolWaitProgressSchema.shape.toolName,
  phase: toolWaitProgressSchema.shape.phase,
  elapsedMs: toolWaitProgressSchema.shape.elapsedMs,
  waitCount: toolWaitProgressSchema.shape.waitCount,
  stage: toolWaitProgressSchema.shape.stage,
}).strict();
export type ChatMetadata = z.infer<typeof ChatMetadataSchema>;
export type DeepResearchProgress = z.infer<typeof deepResearchProgressSchema>;
export type QueuedMessageApplied = z.infer<typeof queuedMessageAppliedSchema>;
export type ToolWaitProgressEvent = z.infer<typeof toolWaitProgressSchema>;

export type ChatDataMap = {
  deepResearchProgress: DeepResearchProgress;
  queuedMessageApplied: QueuedMessageApplied;
  toolWaitProgress: ToolWaitProgressEvent;
};

export const ChatDataSchemas = {
  deepResearchProgress: deepResearchProgressSchema,
  queuedMessageApplied: queuedMessageAppliedSchema,
  toolWaitProgress: toolWaitProgressSchema,
} satisfies ClientDataSchemas<ChatDataMap>;

export type ChatClientEvent = ClientStreamEvent<ChatMetadata, ChatDataMap>;
export type ChatResumableEvent = ClientResumableEvent<ChatMetadata, ChatDataMap>;
export type ChatAgentEvent = AgentStreamEvent<unknown, unknown>;

export type ChatAppEvent =
  | {
      type: "deep_research_progress";
      phase: DeepResearchProgress["phase"];
      message: string;
      activities?: DeepResearchProgress["activities"];
      stats?: DeepResearchProgress["stats"];
    }
  | {
      type: "queued_message_applied";
      clientMessageId: string;
      text?: string;
      attachmentCount: number;
    }
  | {
      type: "tool_wait_progress";
      toolCallId: string;
      toolName: string;
      phase: ToolWaitProgressEvent["phase"];
      elapsedMs: number;
      waitCount: number;
      stage?: string;
    }
  ;

export type ChatStreamEvent = ChatAgentEvent | ChatAppEvent;

function withContext<T extends object>(context: AgentClientStreamContext, event: T) {
  return {
    runId: context.runId,
    ...(context.turn === undefined ? {} : { turn: context.turn }),
    ...(context.scope === undefined ? {} : { scope: context.scope }),
    ...event,
  };
}

/** Map only the application-owned, privacy-safe data event discriminants. */
export function mapChatAppEvent(
  event: ChatAppEvent,
  context: AgentClientStreamContext,
): ChatClientEvent | undefined {
  switch (event.type) {
    case "deep_research_progress": {
      deepResearchAppEventSchema.parse(event);
      const data = deepResearchProgressSchema.parse({
        phase: event.phase,
        message: event.message,
        ...(event.activities === undefined
          ? {}
          : { activities: event.activities }),
        ...(event.stats === undefined ? {} : { stats: event.stats }),
      });
      return withContext(context, { type: "data", name: "deepResearchProgress", data }) as ChatClientEvent;
    }
    case "queued_message_applied": {
      queuedMessageAppEventSchema.parse(event);
      const data = queuedMessageAppliedSchema.parse({
        clientMessageId: event.clientMessageId,
        attachmentCount: event.attachmentCount,
      });
      return withContext(context, { type: "data", name: "queuedMessageApplied", data }) as ChatClientEvent;
    }
    case "tool_wait_progress": {
      toolWaitProgressAppEventSchema.parse(event);
      const data = toolWaitProgressSchema.parse({
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        phase: event.phase,
        elapsedMs: event.elapsedMs,
        waitCount: event.waitCount,
        ...(event.stage === undefined ? {} : { stage: event.stage }),
      });
      return withContext(context, { type: "data", name: "toolWaitProgress", data }) as ChatClientEvent;
    }
  }
}

/**
 * Await persistence of a root interaction continuation before allowing the
 * adapter to expose the interaction and suspended terminal events.
 */
export async function* gateRootInteraction(
  source: AsyncIterable<ChatStreamEvent>,
  onInteraction?: (outcome: AgentInteractionOutcome) => Promise<void>,
): AsyncIterable<ChatStreamEvent> {
  for await (const event of source) {
    if (onInteraction && event.type === "interaction") {
      await onInteraction(event as AgentInteractionOutcome);
    }
    yield event;
  }
}

export function createChatClientStream(options: {
  runId: string;
  metadata?: ChatMetadata;
  events: AsyncIterable<ChatStreamEvent>;
  onInteraction?: (outcome: AgentInteractionOutcome) => Promise<void>;
}): ClientStream<ChatMetadata, ChatDataMap> {
  const metadata = options.metadata === undefined
    ? undefined
    : ChatMetadataSchema.parse(options.metadata);
  return customAgentEventsToClientStream<ChatAppEvent, ChatMetadata, ChatDataMap>({
    runId: options.runId,
    metadata,
    events: gateRootInteraction(options.events, options.onInteraction) as AsyncIterable<ChatAgentEvent | ChatAppEvent>,
    mapCustomEvent: mapChatAppEvent,
  });
}

export function toChatResumableEvent(event: ChatClientEvent): ChatResumableEvent {
  const parsed = parseClientStreamEvent(event, {
    metadataSchema: ChatMetadataSchema,
    dataSchemas: ChatDataSchemas,
  });
  return { protocol: CLIENT_STREAM_PROTOCOL, event: parsed };
}

export function parseChatClientEvent(value: unknown): ChatClientEvent {
  return parseClientStreamEvent(value, {
    metadataSchema: ChatMetadataSchema,
    dataSchemas: ChatDataSchemas,
  });
}

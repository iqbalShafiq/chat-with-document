import type { Redis } from "ioredis";
import {
  Message,
  UserContent,
  type Message as MessageType,
} from "@anvia/core/completion";
import { getRedis } from "../../lib/redis.js";

export type SteerContextSnippet = {
  text: string;
  sourceRole: "user" | "assistant";
};

export type SteerAttachment = {
  mediaType: string;
  data: string; // base64 or data URL
};

export type SteerMessage = {
  clientMessageId: string;
  text: string;
  attachments?: SteerAttachment[];
  contextSnippet?: SteerContextSnippet | null;
};

const STEER_KEY = (streamId: string) => `rs-steer:${streamId}`;
const STEER_SENT_KEY = (streamId: string) => `rs-steer-sent:${streamId}`;
const STEER_TTL_SECONDS = 24 * 60 * 60;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64FromData(value: string): string {
  const match = /^data:[^;]*;base64,(.+)$/s.exec(value);
  return match ? match[1] : value;
}

export function isSteerMessage(value: unknown): value is SteerMessage {
  if (!isRecord(value)) return false;
  if (
    typeof value.clientMessageId !== "string" ||
    value.clientMessageId.length === 0
  ) {
    return false;
  }
  if (typeof value.text !== "string") return false;
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments)) return false;
    for (const attachment of value.attachments) {
      if (
        !isRecord(attachment) ||
        typeof attachment.mediaType !== "string" ||
        typeof attachment.data !== "string"
      ) {
        return false;
      }
    }
  }
  if (value.contextSnippet !== undefined && value.contextSnippet !== null) {
    if (
      !isRecord(value.contextSnippet) ||
      typeof value.contextSnippet.text !== "string" ||
      (value.contextSnippet.sourceRole !== "user" &&
        value.contextSnippet.sourceRole !== "assistant")
    ) {
      return false;
    }
  }
  return true;
}

/** Builds the user Message the SDK steer() accepts (images inline, snippet prepended). */
export function steerMessageToCoreMessage(input: SteerMessage): MessageType {
  const parts: UserContent[] = [];
  for (const attachment of input.attachments ?? []) {
    parts.push(
      UserContent.imageBase64(
        base64FromData(attachment.data),
        attachment.mediaType,
        { detail: "auto" },
      ),
    );
  }
  if (input.contextSnippet && input.contextSnippet.text.trim().length > 0) {
    const source =
      input.contextSnippet.sourceRole === "user"
        ? "User-selected text from an earlier user message"
        : "Text selected from an earlier assistant message";
    parts.push(
      UserContent.text(
        `Additional context\n${source}:\n${input.contextSnippet.text}\n`,
      ),
    );
  }
  if (input.text.trim().length > 0 || parts.length === 0) {
    parts.push(UserContent.text(input.text));
  }
  return Message.user(parts, {
    metadata: {
      clientMessageId: input.clientMessageId,
      queued: true,
      createdAt: new Date().toISOString(),
    },
  });
}

export function createSteeringStore(redis: Redis) {
  return {
    steerKey: STEER_KEY,
    /**
     * Idempotent per stream: a clientMessageId already pushed to this stream
     * (double click / reload while the run is still active) is skipped.
     */
    async push(streamId: string, message: SteerMessage): Promise<boolean> {
      const added = await redis.sadd(
        STEER_SENT_KEY(streamId),
        message.clientMessageId,
      );
      if (added === 0) return false;
      await redis.expire(STEER_SENT_KEY(streamId), STEER_TTL_SECONDS);
      await redis.rpush(STEER_KEY(streamId), JSON.stringify(message));
      await redis.expire(STEER_KEY(streamId), STEER_TTL_SECONDS);
      return true;
    },
    async pop(streamId: string): Promise<SteerMessage | null> {
      const raw = await redis.lpop(STEER_KEY(streamId));
      if (raw === null) return null;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isSteerMessage(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    /** Drops the remaining list; the client still owns those messages. */
    async drain(streamId: string): Promise<number> {
      const count = await redis.llen(STEER_KEY(streamId));
      if (count > 0) {
        await redis.del(STEER_KEY(streamId));
      }
      return count;
    },
  };
}

export type SteeringStore = ReturnType<typeof createSteeringStore>;

let steeringStore: SteeringStore | null = null;

/** Process-wide singleton shared by the chat router and run worker. */
export function getSteeringStore(): SteeringStore {
  if (!steeringStore) {
    steeringStore = createSteeringStore(getRedis());
  }
  return steeringStore;
}

/**
 * Narrow structural view of the SDK's PromptRequest (the class is not
 * exported from the package root). The concrete request satisfies it.
 */
export type SteerableRequest = {
  steer(input: MessageType): boolean;
  stream(): AsyncIterable<unknown>;
};

function isTurnStartEvent(
  event: unknown,
): event is { type: "turn_start"; turn?: unknown } {
  return isRecord(event) && event.type === "turn_start";
}

/**
 * Serializes steering: pops at most one queued message per model turn,
 * acks it (`onApplied`) exactly when the steered turn starts (first
 * turn_start after the steer), and re-injects after a transient retry.
 */
export class SteeringPump {
  private activeSteer: SteerMessage | null = null;
  private steeredAfterTurn = 0;
  private lastTurn = 0;
  private rearmPending = false;

  constructor(
    private readonly streamId: string,
    private readonly steering: SteeringStore,
    private readonly getTarget: () => SteerableRequest | null,
    private readonly onApplied: (applied: SteerMessage) => Promise<void>,
  ) {}

  /** Call when the transient-retry wrapper rebuilds the request. */
  rearmSteer(): void {
    this.rearmPending = true;
  }

  /** Call BEFORE appending an agent stream event to the stream store. */
  async beforeEvent(event: unknown): Promise<void> {
    if (isTurnStartEvent(event) && typeof event.turn === "number") {
      this.lastTurn = event.turn;
    }
    if (
      this.activeSteer !== null &&
      isTurnStartEvent(event) &&
      typeof event.turn === "number" &&
      event.turn > this.steeredAfterTurn
    ) {
      const applied = this.activeSteer;
      this.activeSteer = null;
      await this.onApplied(applied);
    }
  }

  /** Call AFTER appending an agent stream event to the stream store. */
  async afterEvent(): Promise<void> {
    if (this.rearmPending) {
      this.rearmPending = false;
      if (this.activeSteer !== null) {
        const target = this.getTarget();
        if (target !== null) {
          target.steer(steerMessageToCoreMessage(this.activeSteer));
        }
      }
      return;
    }
    if (this.activeSteer !== null) return;
    const item = await this.steering.pop(this.streamId);
    if (item === null) return;
    const target = this.getTarget();
    if (target === null || !target.steer(steerMessageToCoreMessage(item))) {
      console.warn("[chat-run] steer rejected (run terminal)", {
        streamId: this.streamId,
        clientMessageId: item.clientMessageId,
      });
      return;
    }
    this.activeSteer = item;
    this.steeredAfterTurn = this.lastTurn;
  }

  /** Discard leftover list entries (client re-sends after stream end). */
  async drain(): Promise<number> {
    this.activeSteer = null;
    return this.steering.drain(this.streamId);
  }
}

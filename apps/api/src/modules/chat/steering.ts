import type { Redis } from "ioredis";
import type { AgentStream } from "@anvia/core/agent";
import type { UserMessage, UserContentPart } from "@anvia/core/completion";
import { getRedis } from "../../lib/redis.js";

export type SteerContextSnippet = {
  text: string;
  sourceRole: "user" | "assistant";
};

export type SteerAttachment = {
  mediaType: string;
  data: string;
};

export type SteerMessage = {
  clientMessageId: string;
  text: string;
  attachments?: SteerAttachment[];
  contextSnippet?: SteerContextSnippet | null;
};

const STEER_TTL_SECONDS = 24 * 60 * 60;
const MAX_CLIENT_MESSAGE_ID = 256;
const MAX_TEXT = 8_000;
const MAX_ATTACHMENTS = 8;
const MAX_ATTACHMENT_DATA = 12_000_000;
const MAX_SNIPPET_TEXT = 16_000;

const steerTag = (streamId: string) => `{${streamId}}`;
const STEER_KEY = (streamId: string) => `rs-steer:${steerTag(streamId)}:queue`;
const STEER_SENT_KEY = (streamId: string) => `rs-steer:${steerTag(streamId)}:seen`;

const PUSH_SCRIPT = `-- anvia-v1-steer-push
local added = redis.call("SADD", KEYS[2], ARGV[1])
if added == 0 then return 0 end
redis.call("RPUSH", KEYS[1], ARGV[2])
redis.call("EXPIRE", KEYS[1], ARGV[3])
redis.call("EXPIRE", KEYS[2], ARGV[3])
return 1`;

const POP_SCRIPT = `-- anvia-v1-steer-pop
return redis.call("LPOP", KEYS[1]) or ""`;

const REQUEUE_SCRIPT = `-- anvia-v1-steer-requeue
redis.call("LPUSH", KEYS[1], ARGV[1])
redis.call("EXPIRE", KEYS[1], ARGV[2])
return 1`;

const DRAIN_SCRIPT = `-- anvia-v1-steer-drain
local count = redis.call("LLEN", KEYS[1])
redis.call("DEL", KEYS[1])
return count`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isSteerMessage(value: unknown): value is SteerMessage {
  if (!isRecord(value)) return false;
  if (!boundedString(value.clientMessageId, MAX_CLIENT_MESSAGE_ID)) return false;
  if (!boundedString(value.text, MAX_TEXT)) return false;
  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > MAX_ATTACHMENTS) return false;
    if (!value.attachments.every((attachment) =>
      isRecord(attachment) &&
      boundedString(attachment.mediaType, 128) &&
      boundedString(attachment.data, MAX_ATTACHMENT_DATA),
    )) return false;
  }
  if (value.contextSnippet !== undefined && value.contextSnippet !== null) {
    if (!isRecord(value.contextSnippet) ||
      !boundedString(value.contextSnippet.text, MAX_SNIPPET_TEXT) ||
      (value.contextSnippet.sourceRole !== "user" && value.contextSnippet.sourceRole !== "assistant")) {
      return false;
    }
  }
  return true;
}

function base64FromData(value: string): string {
  const match = /^data:[^;]*;base64,(.+)$/s.exec(value);
  return match ? match[1] : value;
}

/** Builds the strict v1 UserMessage accepted by AgentStream.steer({ prompt }). */
export function steerMessageToCoreMessage(input: SteerMessage): UserMessage {
  const parts: UserContentPart[] = [];
  for (const attachment of input.attachments ?? []) {
    parts.push({
      type: "image",
      image: { type: "data", data: base64FromData(attachment.data) },
      mediaType: attachment.mediaType,
      detail: "auto",
    });
  }
  if (input.contextSnippet && input.contextSnippet.text.trim()) {
    const source = input.contextSnippet.sourceRole === "user"
      ? "User-selected text from an earlier user message"
      : "Text selected from an earlier assistant message";
    parts.push({
      type: "text",
      text: `Additional context\n${source}:\n${input.contextSnippet.text}\n`,
    });
  }
  if (input.text.trim() || parts.length === 0) {
    parts.push({ type: "text", text: input.text });
  }
  return {
    role: "user",
    content: parts,
    metadata: {
      clientMessageId: input.clientMessageId,
      queued: true,
      createdAt: new Date().toISOString(),
    },
  };
}

function redisEval(redis: Redis, script: string, keys: string[], args: string[]): Promise<unknown> {
  const command = redis as unknown as { eval?: (...values: string[]) => Promise<unknown> };
  if (typeof command.eval !== "function") throw new Error("steering requires Redis EVAL support");
  return command.eval(script, String(keys.length), ...keys, ...args);
}

function parseRedisJson(value: unknown): SteerMessage | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isSteerMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createSteeringStore(redis: Redis) {
  return {
    async push(streamId: string, message: SteerMessage): Promise<boolean> {
      if (!isSteerMessage(message)) throw new Error("invalid steering message");
      const serialized = JSON.stringify(message);
      const result = await redisEval(
        redis,
        PUSH_SCRIPT,
        [STEER_KEY(streamId), STEER_SENT_KEY(streamId)],
        [message.clientMessageId, serialized, String(STEER_TTL_SECONDS)],
      );
      return Number(result) === 1;
    },

    async pop(streamId: string): Promise<SteerMessage | null> {
      const raw = await redisEval(redis, POP_SCRIPT, [STEER_KEY(streamId)], []);
      return parseRedisJson(raw);
    },

    /** Reinsert an already-seen message after a failed/unapplied stream attempt. */
    async requeue(streamId: string, message: SteerMessage): Promise<void> {
      if (!isSteerMessage(message)) throw new Error("invalid steering message");
      await redisEval(redis, REQUEUE_SCRIPT, [STEER_KEY(streamId)], [JSON.stringify(message), String(STEER_TTL_SECONDS)]);
    },

    async drain(streamId: string): Promise<number> {
      const result = await redisEval(redis, DRAIN_SCRIPT, [STEER_KEY(streamId)], []);
      const count = Number(result);
      if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid steering drain result");
      return count;
    },
  };
}

export type SteeringStore = ReturnType<typeof createSteeringStore>;

let steeringStore: SteeringStore | null = null;

export function getSteeringStore(): SteeringStore {
  if (!steeringStore) steeringStore = createSteeringStore(getRedis());
  return steeringStore;
}

export type SteeringTarget = Pick<AgentStream, "steer">;

type ActiveSteer = {
  message: SteerMessage;
  receiptId: string;
  attempt: number;
};

function isSteeringApplied(event: unknown): event is { type: "steering_applied"; id: string } {
  return isRecord(event) && event.type === "steering_applied" && typeof event.id === "string";
}

/**
 * Owns at most one durable queued message per native stream attempt. The
 * durable item is acknowledged only by the matching v1 steering_applied id.
 */
export class SteeringPump {
  private active: ActiveSteer | null = null;
  private rearmPending = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private attempt = 0;

  constructor(
    private readonly streamId: string,
    private readonly steering: SteeringStore,
    private readonly getTarget: () => SteeringTarget | null,
    private readonly onApplied: (applied: SteerMessage) => Promise<void>,
  ) {}

  rearmSteer(): void {
    if (!this.closed && this.active) {
      this.attempt += 1;
      this.rearmPending = true;
    }
  }

  async beforeEvent(event: unknown): Promise<void> {
    if (this.closed || !this.active || !isSteeringApplied(event)) return;
    if (event.id !== this.active.receiptId) return;
    const applied = this.active.message;
    this.active = null;
    await this.onApplied(applied);
  }

  private async submit(message: SteerMessage): Promise<void> {
    const target = this.getTarget();
    if (!target) {
      await this.steering.requeue(this.streamId, message);
      return;
    }
    const receipt = target.steer({ prompt: steerMessageToCoreMessage(message) });
    if (!receipt || receipt.status !== "queued" || typeof receipt.id !== "string" || receipt.id.length === 0) {
      await this.steering.requeue(this.streamId, message);
      throw new Error("native steering did not return a queued receipt");
    }
    this.active = { message, receiptId: receipt.id, attempt: this.attempt };
  }

  async afterEvent(): Promise<void> {
    if (this.closed || this.active) {
      if (this.rearmPending && this.active) {
        this.rearmPending = false;
        const message = this.active.message;
        this.active = null;
        await this.submit(message);
      }
      return;
    }
    const item = await this.steering.pop(this.streamId);
    if (!item) return;
    await this.submit(item);
  }

  get inFlight(): SteerMessage | null {
    return this.active?.message ?? null;
  }

  async close(options: { requeueUnapplied?: boolean } = {}): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      if (this.active && options.requeueUnapplied) {
        const pending = this.active.message;
        this.active = null;
        await this.steering.requeue(this.streamId, pending);
      } else {
        this.active = null;
      }
    })();
    return this.closePromise;
  }

  async drain(): Promise<number> {
    await this.close();
    return this.steering.drain(this.streamId);
  }
}

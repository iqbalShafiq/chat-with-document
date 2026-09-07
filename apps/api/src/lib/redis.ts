import { Redis, type RedisOptions } from "ioredis";

function redisUrl() {
  return process.env.REDIS_URL ?? "redis://127.0.0.1:16379";
}

function parseRedisUrl(
  url: string,
): Pick<RedisOptions, "host" | "port" | "password" | "db" | "username"> {
  const parsed = new URL(url);
  const dbPath = parsed.pathname.replace(/^\//, "");
  const db = dbPath.length > 0 ? Number(dbPath) : Number.NaN;

  const options: Pick<
    RedisOptions,
    "host" | "port" | "password" | "db" | "username"
  > = {
    // Prefer IPv4 on Windows — `localhost` can resolve to ::1 and flap.
    host: parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 6379,
  };

  if (parsed.username) options.username = parsed.username;
  if (parsed.password) options.password = parsed.password;
  if (Number.isFinite(db)) options.db = db;

  return options;
}

/** Plain options so BullMQ can create/duplicate its own connections. */
export function getBullmqConnectionOptions(): RedisOptions {
  return {
    ...parseRedisUrl(redisUrl()),
    maxRetriesPerRequest: null,
  };
}

let redis: Redis | null = null;
let redisClosePromise: Promise<void> | null = null;

/** Shared non-blocking client for ad-hoc Redis use in the API process. */
export function getRedis() {
  if (!redis) {
    redis = new Redis(getBullmqConnectionOptions());
  }
  return redis;
}

/**
 * Close the process-owned ad-hoc Redis client exactly once. BullMQ owns its
 * duplicated connections and closes them through Worker.close(); this hook is
 * only for the shared client used by stream, policy, and lease stores.
 */
export function closeRedis(): Promise<void> {
  if (redisClosePromise) return redisClosePromise;
  const client = redis;
  if (!client) return Promise.resolve();
  redisClosePromise = client.quit().then(() => undefined).finally(() => {
    if (redis === client) redis = null;
  });
  return redisClosePromise;
}

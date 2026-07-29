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

/** Shared non-blocking client for ad-hoc Redis use in the API process. */
export function getRedis() {
  if (!redis) {
    redis = new Redis(getBullmqConnectionOptions());
  }
  return redis;
}

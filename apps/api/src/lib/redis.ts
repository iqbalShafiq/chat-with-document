import { Redis } from "ioredis";

let redis: Redis | null = null;

export function getRedis() {
  if (!redis) {
    const url = process.env.REDIS_URL ?? "redis://localhost:16379";
    redis = new Redis(url, { maxRetriesPerRequest: null });
  }
  return redis;
}

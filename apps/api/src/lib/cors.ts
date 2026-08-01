import { cors } from "hono/cors";

export function createAppCors() {
  const origin =
    process.env.PLATFORM_ORIGIN?.trim() || "http://localhost:3000";

  return cors({
    origin,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  });
}

import { cors } from "hono/cors";

export function createAppCors() {
  const origin =
    process.env.PLATFORM_ORIGIN?.trim() || "http://localhost:3000";

  return cors({
    origin,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    // DELETE is used by document session unlink (POST /links, DELETE /links);
    // PATCH by session rename (PATCH /sessions/:id).
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });
}

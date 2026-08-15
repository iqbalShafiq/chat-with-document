import { cors } from "hono/cors";
import { resolveAllowedOrigin } from "./origins.js";

export function createAppCors() {
  return cors({
    origin: (origin) => {
      // No Origin (native apps, curl, server-to-server) — CORS does not apply.
      if (!origin) return origin;
      return resolveAllowedOrigin(origin);
    },
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    // Better Auth bearer plugin returns the session token here on sign-in.
    exposeHeaders: ["set-auth-token"],
    // DELETE is used by document session unlink (POST /links, DELETE /links);
    // PATCH by session rename (PATCH /sessions/:id); PUT by context snippet
    // upsert (PUT /chat/:sessionId/context-snippet).
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
}

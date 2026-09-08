import { Hono } from "hono";

import {
  ChatShareNotFoundError,
  getPublicShareSnapshot,
} from "./chat-share.js";

/**
 * Public share links: NO auth middleware. Tokens are unguessable and each
 * row is a frozen snapshot — there is nothing privileged to enumerate.
 */
export const publicShareRouter = new Hono().get("/:token", async (c) => {
  try {
    const snapshot = await getPublicShareSnapshot(c.req.param("token"));
    return c.json(snapshot);
  } catch (error) {
    if (error instanceof ChatShareNotFoundError) {
      return c.json({ error: error.message, code: error.code }, 404);
    }
    throw error;
  }
});

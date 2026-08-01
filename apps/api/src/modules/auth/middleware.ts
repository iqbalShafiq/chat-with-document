import { createMiddleware } from "hono/factory";
import { auth } from "./auth.js";
import type { AuthUser } from "./types.js";

export type AuthVariables = {
  user: AuthUser;
};

export const requireUser = createMiddleware<{ Variables: AuthVariables }>(
  async (c, next) => {
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });

    if (!session?.user) {
      return c.json({ error: "Unauthorized", code: "UNAUTHORIZED" }, 401);
    }

    c.set("user", {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image ?? null,
    });

    await next();
  },
);

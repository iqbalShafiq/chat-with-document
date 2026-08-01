import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { getUserUsageSummary } from "./summary.js";

export const usageRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/summary", async (c) => {
    const user = c.get("user");
    const summary = await getUserUsageSummary(user.id);
    return c.json(summary);
  });

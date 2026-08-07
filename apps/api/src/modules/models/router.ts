import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { listModels } from "./service.js";

export const modelsRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    return c.json(await listModels());
  });

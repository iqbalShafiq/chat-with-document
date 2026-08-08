import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { listModels } from "./service.js";

export const modelsRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const outputType = c.req.query("outputType");
    if (
      outputType !== undefined &&
      outputType !== "text" &&
      outputType !== "image"
    ) {
      return c.json({ error: "outputType must be 'text' or 'image'" }, 400);
    }
    return c.json(await listModels(outputType ? { outputType } : undefined));
  });

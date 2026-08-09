import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { chatRouter } from "./modules/chat/router.js";
import { documentsRouter } from "./modules/documents/router.js";
import { imagesRouter } from "./modules/images/router.js";
import { modelsRouter } from "./modules/models/router.js";
import { projectsRouter } from "./modules/projects/router.js";
import { profilingRouter } from "./modules/profiling/router.js";
import { usageRouter } from "./modules/usage/router.js";
import { auth } from "./modules/auth/auth.js";
import { createAppCors } from "./lib/cors.js";

const app = new Hono()
  .use(createAppCors())
  .on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  .route("/api/chat", chatRouter)
  .route("/api/documents", documentsRouter)
  .route("/api/images", imagesRouter)
  .route("/api/models", modelsRouter)
  .route("/api/projects", projectsRouter)
  .route("/api/profiling", profilingRouter)
  .route("/api/usage", usageRouter);

serve(
  {
    fetch: app.fetch,
    port: Number(process.env.PORT ?? 3001),
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);

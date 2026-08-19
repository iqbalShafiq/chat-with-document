import { Hono } from "hono";
import { createAppCors } from "./lib/cors.js";
import { auth } from "./modules/auth/auth.js";
import { chatRouter } from "./modules/chat/router.js";
import { documentsRouter } from "./modules/documents/router.js";
import { imagesRouter } from "./modules/images/router.js";
import { modelsRouter } from "./modules/models/router.js";
import { profilingRouter } from "./modules/profiling/router.js";
import { projectsRouter } from "./modules/projects/router.js";
import { usageRouter } from "./modules/usage/router.js";
import { registerOpenApi } from "./openapi/register.js";

export function createApp() {
  const app = new Hono()
    .use(createAppCors())
    .get("/health", (c) => c.json({ ok: true }))
    .on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw))
    .route("/api/chat", chatRouter)
    .route("/api/documents", documentsRouter)
    .route("/api/images", imagesRouter)
    .route("/api/models", modelsRouter)
    .route("/api/projects", projectsRouter)
    .route("/api/profiling", profilingRouter)
    .route("/api/usage", usageRouter);

  registerOpenApi(app);
  return app;
}

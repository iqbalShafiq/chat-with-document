import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { chatRouter } from "./modules/chat/router.js";
import { cors } from "hono/cors";

const app = new Hono().use(cors()).route("/api/chat", chatRouter);
 
serve(
  {
    fetch: app.fetch,
    port: Number(process.env.PORT ?? 3001),
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);

import { Scalar } from "@scalar/hono-api-reference";
import type { Hono } from "hono";
import { getApiOrigin } from "../lib/origins.js";
import { buildOpenApiDocument } from "./document.js";

/**
 * Public documentation routes (official Scalar + Hono integration):
 *   GET /doc           OpenAPI 3.1 document
 *   GET /openapi.json  same document (common client convention)
 *   GET /scalar        Scalar API Reference UI
 *
 * @see https://hono.dev/examples/scalar
 * @see https://scalar.com/products/api-references/integrations/hono
 */
export function registerOpenApi(app: Hono) {
  const serveDocument = (c: { json: (body: unknown) => Response }) =>
    c.json(buildOpenApiDocument({ serverUrl: getApiOrigin() }));

  app.get("/doc", serveDocument);
  app.get("/openapi.json", serveDocument);

  app.get(
    "/scalar",
    Scalar({
      url: "/doc",
      pageTitle: "Chat with Document API",
      theme: "purple",
      authentication: {
        preferredSecurityScheme: "bearerAuth",
      },
    }),
  );
}

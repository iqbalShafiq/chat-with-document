import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerOpenApi } from "./register.js";

function docsApp() {
  const app = new Hono();
  registerOpenApi(app);
  return app;
}

describe("OpenAPI HTTP routes", () => {
  it("serves the OpenAPI document at /doc and /openapi.json", async () => {
    const app = docsApp();

    const doc = await app.request("/doc");
    expect(doc.status).toBe(200);
    expect(doc.headers.get("content-type")).toMatch(/json/);
    const body = (await doc.json()) as { openapi?: string; paths?: unknown };
    expect(body.openapi).toBe("3.1.0");
    expect(body.paths).toBeTypeOf("object");

    const alias = await app.request("/openapi.json");
    expect(alias.status).toBe(200);
    const aliasBody = (await alias.json()) as { openapi?: string };
    expect(aliasBody.openapi).toBe("3.1.0");
  });

  it("serves the Scalar UI at /scalar", async () => {
    const app = docsApp();
    const res = await app.request("/scalar");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/scalar|api-reference/i);
    expect(html).toContain("/doc");
  });
});

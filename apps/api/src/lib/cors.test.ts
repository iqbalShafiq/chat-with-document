import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAppCors } from "./cors.js";

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env.PLATFORM_ORIGIN = ORIGINAL.PLATFORM_ORIGIN;
  process.env.BETTER_AUTH_URL = ORIGINAL.BETTER_AUTH_URL;
  process.env.TRUSTED_ORIGINS = ORIGINAL.TRUSTED_ORIGINS;
});

function corsApp() {
  return new Hono()
    .use(createAppCors())
    .get("/ping", (c) => c.json({ ok: true }));
}

describe("createAppCors", () => {
  it("allows the platform origin with credentials", async () => {
    process.env.PLATFORM_ORIGIN = "http://localhost:3000";
    process.env.BETTER_AUTH_URL = "http://localhost:3001";
    delete process.env.TRUSTED_ORIGINS;

    const res = await corsApp().request("/ping", {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3000",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("allows extra TRUSTED_ORIGINS (mobile webview / Expo)", async () => {
    process.env.PLATFORM_ORIGIN = "http://localhost:3000";
    process.env.BETTER_AUTH_URL = "http://localhost:3001";
    process.env.TRUSTED_ORIGINS = "http://localhost:8081";

    const res = await corsApp().request("/ping", {
      headers: { origin: "http://localhost:8081" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:8081",
    );
  });

  it("allows the API origin so Scalar Try-it works", async () => {
    process.env.PLATFORM_ORIGIN = "http://localhost:3000";
    process.env.BETTER_AUTH_URL = "http://localhost:3001";
    delete process.env.TRUSTED_ORIGINS;

    const res = await corsApp().request("/ping", {
      headers: { origin: "http://localhost:3001" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:3001",
    );
  });

  it("rejects an unknown browser origin", async () => {
    process.env.PLATFORM_ORIGIN = "http://localhost:3000";
    process.env.BETTER_AUTH_URL = "http://localhost:3001";
    delete process.env.TRUSTED_ORIGINS;

    const res = await corsApp().request("/ping", {
      headers: { origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("lets native clients through when no Origin is sent", async () => {
    const res = await corsApp().request("/ping");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

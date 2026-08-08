import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("./service.js", () => ({
  listModels: vi.fn(),
}));

vi.mock("../auth/middleware.js", () => ({
  requireUser: async (_c: unknown, next: () => Promise<void>) => next(),
}));

import { modelsRouter } from "./router.js";
import { listModels } from "./service.js";

const app = new Hono().route("/api/models", modelsRouter);

describe("GET /api/models", () => {
  beforeEach(() => {
    vi.mocked(listModels).mockClear().mockResolvedValue({
      models: [],
      reasoningEfforts: [],
    });
  });

  it("returns all models when outputType is absent", async () => {
    const res = await app.request("/api/models");

    expect(res.status).toBe(200);
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it("passes outputType=image to the service", async () => {
    const res = await app.request("/api/models?outputType=image");

    expect(res.status).toBe(200);
    expect(listModels).toHaveBeenCalledWith({ outputType: "image" });
  });

  it("passes outputType=text to the service", async () => {
    const res = await app.request("/api/models?outputType=text");

    expect(res.status).toBe(200);
    expect(listModels).toHaveBeenCalledWith({ outputType: "text" });
  });

  it("rejects an invalid outputType with 400", async () => {
    const res = await app.request("/api/models?outputType=video");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "outputType must be 'text' or 'image'",
    });
    expect(listModels).not.toHaveBeenCalled();
  });
});

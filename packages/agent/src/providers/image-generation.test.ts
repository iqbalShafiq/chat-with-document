import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mapOpenRouterImageError,
  OpenRouterImageGenerationModel,
  type OpenRouterImageGenerationModelOptions,
} from "./image-generation.js";

const API_KEY = "sk-or-test-key";
const BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-5-image-mini";

function mockFetch(
  body: unknown,
  ok = true,
  status = 200,
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function makeModel(
  options?: Partial<OpenRouterImageGenerationModelOptions>,
): OpenRouterImageGenerationModel {
  return new OpenRouterImageGenerationModel({
    apiKey: API_KEY,
    baseUrl: BASE_URL,
    ...options,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenRouterImageGenerationModel", () => {
  it("posts to the images endpoint with merged params and auth header", async () => {
    const fetchMock = mockFetch({ data: [] });
    const model = makeModel();

    await model.imageGeneration({
      prompt: "a red fox in the snow",
      width: 1024,
      height: 1024,
      additionalParams: { quality: "high" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/images`);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body)).toEqual({
      model: DEFAULT_MODEL,
      prompt: "a red fox in the snow",
      size: "1024x1024",
      quality: "high",
    });
  });

  it("decodes a single b64 image with media type", async () => {
    const b64 = Buffer.from("AB", "utf8").toString("base64");
    const raw = {
      data: [{ b64_json: b64, media_type: "image/png" }],
      usage: { total_cost: 0.01 },
    };
    mockFetch(raw);
    const model = makeModel();

    const result = await model.imageGeneration({
      prompt: "a red fox in the snow",
      width: 512,
      height: 512,
    });

    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.mediaType).toBe("image/png");
    expect(result.images[0]!.data).toEqual(
      new Uint8Array(Buffer.from("AB", "utf8")),
    );
    expect(result.image).toBe(result.images[0]!.data);
    expect(result.mediaType).toBe("image/png");
    expect(result.rawResponse).toEqual(raw);
  });

  it("maps multiple images in order", async () => {
    mockFetch({
      data: [
        { b64_json: Buffer.from("A", "utf8").toString("base64"), media_type: "image/png" },
        { b64_json: Buffer.from("B", "utf8").toString("base64"), media_type: "image/jpeg" },
      ],
    });
    const model = makeModel();

    const result = await model.imageGeneration({
      prompt: "a red fox in the snow",
      width: 256,
      height: 256,
    });

    expect(result.images).toHaveLength(2);
    expect(result.images[0]!.data).toEqual(new Uint8Array(Buffer.from("A", "utf8")));
    expect(result.images[0]!.mediaType).toBe("image/png");
    expect(result.images[1]!.data).toEqual(new Uint8Array(Buffer.from("B", "utf8")));
    expect(result.images[1]!.mediaType).toBe("image/jpeg");
    expect(result.image).toBe(result.images[0]!.data);
  });

  it("skips entries without a b64 payload", async () => {
    mockFetch({
      data: [
        { b64_json: null, media_type: "image/png" },
        { b64_json: 123, media_type: "image/jpeg" },
      ],
    });
    const model = makeModel();

    const result = await model.imageGeneration({
      prompt: "a red fox in the snow",
      width: 256,
      height: 256,
    });

    expect(result.images).toEqual([]);
    expect(result.image).toEqual(new Uint8Array());
    expect(result.mediaType).toBeUndefined();
  });

  it("returns empty results when data is missing", async () => {
    mockFetch({});
    const model = makeModel();

    const result = await model.imageGeneration({
      prompt: "a red fox in the snow",
      width: 256,
      height: 256,
    });

    expect(result.images).toEqual([]);
    expect(result.image).toEqual(new Uint8Array());
  });

  it.each([
    [401, "Image generation is not configured (invalid API key)"],
    [403, "Image generation is not configured (invalid API key)"],
    [429, "Image generation rate limit exceeded; try again later"],
    [400, "Image generation rejected the request; adjust the parameters"],
    [502, "Image generation failed before billing; try again"],
  ])("maps HTTP %i to a bounded message", async (status, message) => {
    mockFetch({}, false, status);
    const model = makeModel();

    await expect(
      model.imageGeneration({ prompt: "p", width: 256, height: 256 }),
    ).rejects.toThrow(message);
  });

  it("maps fetch network failures to a bounded message", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);
    const model = makeModel();

    await expect(
      model.imageGeneration({ prompt: "p", width: 256, height: 256 }),
    ).rejects.toThrow("Image generation temporarily unavailable");
  });

  it("strips a trailing slash from baseUrl", async () => {
    const fetchMock = mockFetch({ data: [] });
    const model = new OpenRouterImageGenerationModel({
      apiKey: API_KEY,
      baseUrl: `${BASE_URL}/`,
    });

    await model.imageGeneration({ prompt: "p", width: 256, height: 256 });

    expect(fetchMock.mock.calls[0]![0]).toBe(`${BASE_URL}/images`);
  });

  it("falls back to the default model when none is provided", async () => {
    const fetchMock = mockFetch({ data: [] });
    const model = new OpenRouterImageGenerationModel({
      apiKey: API_KEY,
      baseUrl: BASE_URL,
    });

    await model.imageGeneration({ prompt: "p", width: 256, height: 256 });

    expect(model.defaultModel).toBe(DEFAULT_MODEL);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe(
      DEFAULT_MODEL,
    );
  });

  it("uses the configured default model", async () => {
    const fetchMock = mockFetch({ data: [] });
    const model = makeModel({ defaultModel: "google/gemini-2.5-flash-image" });

    await model.imageGeneration({ prompt: "p", width: 256, height: 256 });

    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).model).toBe(
      "google/gemini-2.5-flash-image",
    );
  });
});

describe("mapOpenRouterImageError", () => {
  it("maps auth failures to a configuration message", () => {
    expect(mapOpenRouterImageError({ status: 401 })).toBe(
      "Image generation is not configured (invalid API key)",
    );
    expect(mapOpenRouterImageError({ status: 403 })).toBe(
      "Image generation is not configured (invalid API key)",
    );
  });

  it("maps non-object errors to the fallback message", () => {
    expect(mapOpenRouterImageError(null)).toBe(
      "Image generation temporarily unavailable",
    );
    expect(mapOpenRouterImageError("boom")).toBe(
      "Image generation temporarily unavailable",
    );
    expect(mapOpenRouterImageError(new Error("boom"))).toBe(
      "Image generation temporarily unavailable",
    );
  });
});

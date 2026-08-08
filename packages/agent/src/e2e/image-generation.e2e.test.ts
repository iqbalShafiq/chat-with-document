import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { TavilyClient } from "@tavily/core";
import { OpenRouterImageGenerationModel } from "../providers/image-generation.js";
import {
  createImageGenerationTools,
  type GeneratedImageRecord,
  type GenerateImageResult,
  type ImageGenerationToolScope,
} from "../tools/image-generation.js";
import { createWebSearchTools } from "../tools/web-search.js";

const DEFAULT_MODEL = "openai/gpt-5-image-mini";

/** 1x1 transparent PNG — decodes cleanly through the model's base64 path. */
const TRANSPARENT_1X1_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type StubImageRequest = {
  model: string;
  prompt: string;
  size: string;
  n?: number;
  background?: string;
  output_format?: string;
  quality?: string;
  input_references?: Array<{
    type: "image_url";
    image_url: { url: string };
  }>;
};

/**
 * Stub OpenRouter images endpoint: records every request body and answers
 * with `n` (default 1) copies of a 1x1 transparent PNG, mirroring the
 * `{ data: [{ b64_json, media_type }] }` contract the real API returns.
 */
function startStubServer(): Promise<{
  server: Server;
  port: number;
  requests: StubImageRequest[];
}> {
  const requests: StubImageRequest[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/api/v1/images") {
      response.writeHead(404);
      response.end();
      return;
    }
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body as unknown as StubImageRequest);
      const count = typeof body.n === "number" ? body.n : 1;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          data: Array.from({ length: count }, () => ({
            b64_json: TRANSPARENT_1X1_PNG_BASE64,
            media_type: "image/png",
          })),
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ server, port: address.port, requests });
    });
  });
}

let server: Server;
let stubRequests: StubImageRequest[];
let model: OpenRouterImageGenerationModel;

beforeAll(async () => {
  const stub = await startStubServer();
  server = stub.server;
  stubRequests = stub.requests;
  model = new OpenRouterImageGenerationModel({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${stub.port}/api/v1`,
    fetchFn: fetch,
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  stubRequests.length = 0;
});

type ApprovalPolicy = {
  when(context: unknown): boolean | Promise<boolean>;
  reason(context: { args: { prompt: string } }): string;
};

function approvalContext(args: Record<string, unknown>) {
  return {
    toolName: "generate_image",
    args,
    rawArgs: JSON.stringify(args),
    internalCallId: "internal-call-1",
    run: { runId: "run-1", agentId: "agent-1", sessionId: "session-1" },
  };
}

function makeScope(
  overrides: Partial<ImageGenerationToolScope> = {},
): {
  scope: ImageGenerationToolScope;
  saveGeneratedImage: ReturnType<typeof vi.fn>;
} {
  const saveGeneratedImage = vi.fn();
  let recordCount = 0;
  saveGeneratedImage.mockImplementation(
    async (input: {
      mediaType: string | undefined;
      width: number;
      height: number;
      modelId: string;
      prompt: string;
    }): Promise<GeneratedImageRecord> => ({
      id: `rec-${++recordCount}`,
      mediaType: input.mediaType ?? "image/png",
      width: input.width,
      height: input.height,
      modelId: input.modelId,
      prompt: input.prompt,
    }),
  );
  const scope: ImageGenerationToolScope = {
    model,
    store: { saveGeneratedImage },
    enabled: true,
    hasGrant: () => false,
    takeToolOverride: () => null,
    userId: "user-1",
    sessionId: "session-1",
    projectId: null,
    resolveReference: async () => null,
    capabilities: () => null,
    ...overrides,
  };
  return { scope, saveGeneratedImage };
}

describe("generate_image happy path (toggle ON)", () => {
  it("posts to the stub, saves the returned image, and reports metadata without base64", async () => {
    const { scope, saveGeneratedImage } = makeScope();
    const generate = createImageGenerationTools(scope)[0]!;

    const output = (await generate.call({
      prompt: "a red panda",
    })) as GenerateImageResult;

    expect(stubRequests).toHaveLength(1);
    expect(stubRequests[0]).toEqual({
      model: DEFAULT_MODEL,
      prompt: "a red panda",
      size: "1024x1024",
    });

    expect(saveGeneratedImage).toHaveBeenCalledTimes(1);
    const saved = saveGeneratedImage.mock.calls[0]![0];
    expect(saved).toMatchObject({
      userId: "user-1",
      sessionId: "session-1",
      projectId: null,
      mediaType: "image/png",
      modelId: DEFAULT_MODEL,
      prompt: "a red panda",
      width: 1024,
      height: 1024,
    });
    expect(saved.buffer.byteLength).toBeGreaterThan(0);

    expect(output.images).toHaveLength(1);
    expect(output.images[0]).toMatchObject({
      imageId: "rec-1",
      mediaType: "image/png",
      width: 1024,
      height: 1024,
      modelId: DEFAULT_MODEL,
      prompt: "a red panda",
      index: 0,
      total: 1,
    });
    expect(JSON.stringify(output)).not.toContain("base64");
    expect(output.error).toBeUndefined();
  });
});

describe("multi-image generation (n=3)", () => {
  it("asks the stub for 3 images and reports each with nOfTotal", async () => {
    const { scope, saveGeneratedImage } = makeScope();
    const generate = createImageGenerationTools(scope)[0]!;

    const output = (await generate.call({
      prompt: "a red panda",
      n: 3,
    })) as GenerateImageResult;

    expect(stubRequests).toHaveLength(1);
    expect(stubRequests[0]!.n).toBe(3);

    expect(saveGeneratedImage).toHaveBeenCalledTimes(3);
    expect(saveGeneratedImage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ nOfTotal: "1 of 3" }),
    );
    expect(saveGeneratedImage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ nOfTotal: "2 of 3" }),
    );
    expect(saveGeneratedImage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ nOfTotal: "3 of 3" }),
    );

    expect(output.images).toHaveLength(3);
    expect(output.images.map((image) => image.imageId)).toEqual([
      "rec-1",
      "rec-2",
      "rec-3",
    ]);
    expect(output.images[0]!.total).toBe(3);
  });
});

describe("approval gate (toggle OFF)", () => {
  it("requires approval when the toggle is off, and skips it once a grant exists", async () => {
    const { scope } = makeScope({ enabled: false });
    const generate = createImageGenerationTools(scope)[0]!;
    const approval = generate.approval as ApprovalPolicy;
    const context = approvalContext({ prompt: "a red panda" });

    expect(await approval.when(context)).toBe(true);
    expect(approval.reason({ args: { prompt: "a red panda" } })).toBe(
      'The agent wants to generate an image: "a red panda"',
    );

    const granted = createImageGenerationTools({
      ...scope,
      hasGrant: () => true,
    });
    const grantedApproval = granted[0]!.approval as ApprovalPolicy;
    expect(await grantedApproval.when(context)).toBe(false);
  });
});

describe("background removal", () => {
  it("requests a transparent background with png output format", async () => {
    const { scope } = makeScope();
    const generate = createImageGenerationTools(scope)[0]!;

    await generate.call({ prompt: "a red panda", background: "transparent" });

    expect(stubRequests).toHaveLength(1);
    expect(stubRequests[0]).toEqual({
      model: DEFAULT_MODEL,
      prompt: "a red panda",
      size: "1024x1024",
      background: "transparent",
      output_format: "png",
    });
  });
});

describe("web search → image reference flow", () => {
  it("feeds a web_search result text into the generate_image prompt", async () => {
    const tavilyClient = {
      search: vi.fn(async () => ({
        query: "red panda appearance",
        answer: "Red pandas have reddish-brown fur, black legs, and a ringed tail.",
        results: [
          {
            title: "Red panda facts",
            url: "https://example.com/red-panda",
            content: "Red pandas are small arboreal mammals with a white face mask.",
            score: 0.95,
            publishedDate: "2026-01-01",
          },
        ],
        responseTime: 42,
        images: [],
        requestId: "req-1",
      })),
      extract: vi.fn(),
    } as unknown as TavilyClient;

    const webSearch = createWebSearchTools({ tavilyClient, enabled: true })[0]!;
    const searchOutput = (await webSearch.call({
      query: "red panda appearance",
      reason: "I need accurate visual details to build the image prompt",
    })) as {
      answer: string | null;
      results: Array<{ content: string }>;
    };

    const enrichedPrompt = `a red panda: ${searchOutput.answer} ${searchOutput.results[0]!.content}`;

    const { scope } = makeScope();
    const generate = createImageGenerationTools(scope)[0]!;
    await generate.call({ prompt: enrichedPrompt });

    expect(tavilyClient.search).toHaveBeenCalledWith(
      "red panda appearance",
      expect.objectContaining({ searchDepth: "basic", includeAnswer: "basic" }),
    );
    expect(stubRequests).toHaveLength(1);
    expect(stubRequests[0]!.prompt).toBe(enrichedPrompt);
    expect(stubRequests[0]!.prompt).toContain("reddish-brown fur");
    expect(stubRequests[0]!.prompt).toContain("white face mask");
  });
});

describe("edit_image with a reference image", () => {
  it("sends the reference as an input_references data URL and saves the result", async () => {
    const { scope, saveGeneratedImage } = makeScope({
      resolveReference: async () => ({
        mediaType: "image/png",
        buffer: Uint8Array.from(Buffer.from(TRANSPARENT_1X1_PNG_BASE64, "base64")),
      }),
    });
    const tools = createImageGenerationTools(scope);

    const output = (await tools[1]!.call({
      prompt: "make it watercolor",
      referenceImageId: "img_1",
    })) as GenerateImageResult;

    expect(stubRequests).toHaveLength(1);
    expect(stubRequests[0]).toEqual({
      model: DEFAULT_MODEL,
      prompt: "make it watercolor",
      size: "1024x1024",
      input_references: [
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${TRANSPARENT_1X1_PNG_BASE64}`,
          },
        },
      ],
    });

    expect(saveGeneratedImage).toHaveBeenCalledTimes(1);
    expect(saveGeneratedImage.mock.calls[0]![0]).toMatchObject({
      prompt: "make it watercolor",
      mediaType: "image/png",
    });
    expect(output.images).toHaveLength(1);
    expect(output.images[0]!.imageId).toBe("rec-1");
  });
});

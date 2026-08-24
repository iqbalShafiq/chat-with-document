import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ToolApprovalContext } from "@anvia/core/tool";
import { vi, type Mock } from "vitest";
import { OpenRouterImageGenerationModel } from "../providers/image-generation.js";
import type { GeneratedImageRecord } from "../tools/image-generation.js";

/**
 * Shared scaffolding for the agent- and api-level E2E image-generation tests:
 * the stub OpenRouter HTTP server, the fake save-store, and the approval
 * context builders.
 *
 * IMPORTANT: this module must never import providers/openai.js or
 * providers/mistral.js (or the agent index) — those construct clients at
 * module load and throw without credentials. apps/api imports this file at
 * module scope, before its beforeAll stubs fake env vars.
 */

/** 1x1 transparent PNG — decodes cleanly through the model's base64 path. */
export const TRANSPARENT_1X1_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export type StubImageRequest = {
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
export function startStubServer(): Promise<{
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

/** OpenRouterImageGenerationModel pointed at the stub, via injected fetch. */
export function createStubOpenRouterModel(port: number) {
  return new OpenRouterImageGenerationModel({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    fetchFn: fetch,
  });
}

/** Minimal approval context Anvia hands a gated tool call. */
export function approvalContext<Args extends Record<string, unknown>>(
  args: Args,
): ToolApprovalContext<Args> {
  return {
    toolName: "generate_image",
    args,
    rawArgs: JSON.stringify(args),
    toolCallId: "tool-call-1",
    internalCallId: "internal-call-1",
    run: { runId: "run-1", agentId: "agent-1", sessionId: "session-1" },
  };
}

/**
 * The fake store's callable surface (also typed as a Mock for .mock access).
 * Mirrors the store input contract in tools/image-generation.ts exactly
 * (note: mediaType is required as `string | undefined` — with
 * exactOptionalPropertyTypes an optional property cannot receive undefined).
 */
export type SaveGeneratedImage = (input: {
  userId: string;
  sessionId: string;
  projectId: string | null;
  buffer: Uint8Array;
  mediaType: string | undefined;
  modelId: string;
  prompt: string;
  width: number;
  height: number;
  nOfTotal?: string;
}) => Promise<GeneratedImageRecord>;

/**
 * Fake save-store returning deterministic record ids — the tool needs a real
 * GeneratedImageRecord-shaped result to report image ids in its output.
 */
export function createSaveGeneratedImageMock(): Mock<SaveGeneratedImage> {
  const saveGeneratedImage = vi.fn();
  let recordCount = 0;
  saveGeneratedImage.mockImplementation(
    async (input: {
      mediaType?: string;
      width: number;
      height: number;
      modelId: string;
      prompt: string;
    }) => ({
      id: `rec-${++recordCount}`,
      mediaType: input.mediaType ?? "image/png",
      width: input.width,
      height: input.height,
      modelId: input.modelId,
      prompt: input.prompt,
    }),
  );
  return saveGeneratedImage;
}

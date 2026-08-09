# Image Generation + Human Approval & Clarification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add OpenRouter-backed image generation (`generate_image`, `edit_image`) with a two-layer human-in-the-loop (session-grant approval + generic multi-question clarification tool), image storage in R2/Postgres with project-scoped galleries in both sidebars, background-removal via `background: "transparent"`, and an idempotent (upsert) model seed with capability columns.

**Architecture:** A custom `OpenRouterImageGenerationModel implements ImageGenerationModel` (from `@anvia/core/image-generation`) calls OpenRouter's dedicated `POST /api/v1/images`. Tools (`generate_image`, `edit_image`) carry Anvia approval policies that check a Redis session grant; a generic `request_clarification` tool lets the agent ask the user multi-question wizards through the same registry core. Images are stored in R2 with `GeneratedImage` rows (1 image = 1 generate), served with ownership checks, and surfaced in a right-rail session gallery plus a left-sidebar project-filterable gallery.

**Tech Stack:** TypeScript, Anvia 0.16 (`createTool`, `image-generation`, approvals), Hono, BullMQ, Redis (ioredis), Prisma/Postgres, Cloudflare R2, React 19 + Vite + Tailwind 4 + TanStack Router, Vitest, Playwright.

---

## Task 0: Prisma migration — `ChatModel` capability columns + `GeneratedImage` table

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (ChatModel model ~line 312, append GeneratedImage model)
- Create: `apps/api/prisma/migrations/20260808000000_image_generation/migration.sql` (via `pnpm --filter api prisma migrate dev --name image_generation`)
- Test: `apps/api/src/modules/models/service.test.ts` (new — assert new fields in MODEL_SELECT)

**Step 1: Edit schema.** In `ChatModel` add:

```prisma
  /// "text" | "image" — whether this model is a chat model or an image generator.
  outputType                String                @default("text")
  /// Modalities the model accepts as input, e.g. ["text","image"].
  inputModalities           Json?
  /// Modalities the model produces, e.g. ["text"] or ["image"].
  outputModalities          Json?
  /// Image-gen capability descriptors (from OpenRouter discovery):
  /// { aspectRatios: string[], quality?: string[], n: {min,max}, background?: string[], resolutions?: string[] }
  imageCapabilities         Json?
```

Append new model:

```prisma
model GeneratedImage {
  id        String   @id @default(cuid())
  userId    String
  /// Null for standalone (global) chats.
  projectId String?
  sessionId String
  r2Key     String   @unique
  mediaType String
  width     Int
  height    Int
  modelId   String
  prompt    String
  /// e.g. "2 of 3" when generated in a multi-image call.
  nOfTotal  String?
  createdAt DateTime @default(now())

  @@index([userId, projectId])
  @@index([sessionId])
  @@map("generated_image")
}
```

**Step 2: Run migration.**

Run: `pnpm --filter api prisma migrate dev --name image_generation`
Expected: migration applied, `GeneratedImage` table + 4 new ChatModel columns exist.

**Step 3: Write the failing test** `apps/api/src/modules/models/service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MODEL_SELECT } from "./service.js";

describe("models service", () => {
  it("exposes capability columns on MODEL_SELECT", () => {
    const keys = Object.keys(MODEL_SELECT);
    expect(keys).toContain("outputType");
    expect(keys).toContain("inputModalities");
    expect(keys).toContain("outputModalities");
    expect(keys).toContain("imageCapabilities");
  });
});
```

**Step 4:** add `outputType`, `inputModalities`, `outputModalities`, `imageCapabilities` to `MODEL_SELECT` in `apps/api/src/modules/models/service.ts` (~line 100-115).

**Step 5: Run test, then commit.**

Run: `pnpm --filter api test`
Expected: PASS.
```bash
git add apps/api/prisma apps/api/src/modules/models
git commit -m "feat(db): chat model capability columns + generated_image table"
```

---

## Task 1: Seed upsert + 3 image models

**Files:**
- Modify: `apps/api/prisma/seed.ts`
- Test: `apps/api/src/lib/seed-upsert.test.ts` (new — pure-helper tests for row diffing)

**Step 1: Write failing tests** for a pure helper `buildSeedUpsertPairs(seedRows, existingRows)` in `apps/api/prisma/seed-helpers.ts`:

```ts
// seed-helpers.ts
export function buildSeedUpsertPairs<T extends { key: string }>(
  seedRows: T[],
  existingRows: T[],
): { create: T[]; update: { where: string; data: T }[]; unchanged: number } {
  const existing = new Map(existingRows.map((r) => [r.key, r]));
  const create: T[] = [];
  const update: { where: string; data: T }[] = [];
  let unchanged = 0;
  for (const row of seedRows) {
    const current = existing.get(row.key);
    if (!current) create.push(row);
    else if (JSON.stringify(current) !== JSON.stringify(row)) {
      update.push({ where: row.key, data: row });
    } else unchanged++;
  }
  return { create, update, unchanged };
}
```

Tests (`seed-helpers.test.ts`): new row → create; identical → unchanged; changed → update; run twice → second run all unchanged.

**Step 2: Rewrite `seed.ts` main()** to upsert semantics:

- Upsert `ModelProvider` by `slug`, `ReasoningEffort` by `key`, `ChatModel` by `modelId` (update full row), `ModelReasoningEffort` by `@@unique([modelId, effortId])` (via `upsert` with `create`/`update`).
- Keep the prune: `chatModel.deleteMany({ where: { modelId: { notIn: seedIds } } })`.
- Add `GEMINI_ICON_SVG` + `GROK_ICON_SVG` (simple wordmark SVGs with `currentColor`).
- Add 3 image models (capabilities from OpenRouter discovery, verified 2026-08-08):

```ts
{
  providerSlug: "openai", modelId: "openai/gpt-5-image-mini",
  name: "GPT-5 Image Mini", label: "GPT-5 Image Mini", hint: "Fastest • $0.008/img",
  description: "OpenAI image generation, low cost. Supports transparent background.",
  contextWindowTokens: 0, outputType: "image",
  inputModalities: ["text", "image", "file"], outputModalities: ["image"],
  imageCapabilities: { quality: ["auto","low","medium","high"], background: ["auto","transparent","opaque"],
    n: { min: 1, max: 10 }, aspectRatios: ["1:1","3:2","2:3","4:3","3:4","16:9","9:16","21:9","auto"] },
  iconSvg: OPENAI_ICON_SVG, sortOrder: 0, supportsReasoning: false, reasoningEffortKeys: [],
},
{
  providerSlug: "google", modelId: "google/gemini-3.1-flash-lite-image",
  name: "Nano Banana 2 Lite", label: "Gemini Flash Lite Image", hint: "Cheapest • $0.03/img",
  description: "Google Nano Banana 2 Lite — rich aspect ratios at 1K.",
  contextWindowTokens: 0, outputType: "image",
  inputModalities: ["image", "text"], outputModalities: ["image", "text"],
  imageCapabilities: { resolutions: ["1K"], n: { min: 1, max: 1 },
    aspectRatios: ["1:1","1:4","1:8","2:3","3:2","3:4","4:1","4:3","4:5","5:4","8:1","9:16","16:9","21:9"] },
  iconSvg: GEMINI_ICON_SVG, sortOrder: 1, supportsReasoning: false, reasoningEffortKeys: [],
},
{
  providerSlug: "xai", modelId: "x-ai/grok-imagine-image-quality",
  name: "Grok Imagine", label: "Grok Imagine (Quality)", hint: "1K/2K • $0.05–0.07/img",
  description: "xAI Grok Imagine — quality tier, 1K/2K resolutions.",
  contextWindowTokens: 0, outputType: "image",
  inputModalities: ["text", "image"], outputModalities: ["image"],
  imageCapabilities: { resolutions: ["1K", "2K"], n: { min: 1, max: 1 },
    aspectRatios: ["1:1","3:4","4:3","9:16","16:9","2:3","3:2","9:19.5","19.5:9","1:2","2:1","auto"] },
  iconSvg: GROK_ICON_SVG, sortOrder: 2, supportsReasoning: false, reasoningEffortKeys: [],
},
```

- Add provider rows: `{ slug: "google", name: "Google" }`, `{ slug: "xai", name: "xAI" }`.
- Backfill existing text models: `inputModalities: ["text"]`, `outputModalities: ["text"]`, `outputType: "text"`.

**Step 3: Run seed twice.**

Run: `pnpm --filter api prisma db seed` (twice)
Expected: second run reports `removed=0` and unchanged rows untouched; `models=5`.

**Step 4: Run all tests + commit.**

```bash
git add apps/api/prisma
git commit -m "feat(db): idempotent upsert seed + image model catalog"
```

---

## Task 2: `OpenRouterImageGenerationModel` provider (`packages/agent`)

**Files:**
- Create: `packages/agent/src/providers/image-generation.ts`
- Modify: `packages/agent/src/index.ts` (export)
- Test: `packages/agent/src/providers/image-generation.test.ts`

**Step 1: Write failing tests** (mock `fetch` via `vi.stubGlobal`):

- POSTs to `${baseUrl}/images` with `{ model, prompt, size: "1024x1024", quality }`.
- Parses `data[].b64_json` (+ `media_type`) → `images: GeneratedImage[]` (Uint8Array + mediaType), `image` = first.
- Maps errors: 401/403 → "not configured", 429 → "rate limited", 400 → "rejected", 502 → "generation failed", network → "unavailable".

**Step 2: Implement `packages/agent/src/providers/image-generation.ts`:**

```ts
import type {
  GeneratedImage,
  ImageGenerationModel,
  ImageGenerationRequest,
  ImageGenerationResponse,
} from "@anvia/core/image-generation";

export type OpenRouterImageGenerationModelOptions = {
  apiKey: string;
  baseUrl: string;
  defaultModel?: string;
  fetchFn?: typeof fetch;
};

export function mapOpenRouterImageError(error: unknown): string {
  if (!error || typeof error !== "object") return "Image generation temporarily unavailable";
  const record = error as { status?: unknown; message?: unknown };
  const status = typeof record.status === "number" ? record.status : null;
  if (status === 401 || status === 403) return "Image generation is not configured (invalid API key)";
  if (status === 429) return "Image generation rate limit exceeded; try again later";
  if (status === 400) return "Image generation rejected the request; adjust the parameters";
  if (status === 502) return "Image generation failed before billing; try again";
  return "Image generation temporarily unavailable";
}

export class OpenRouterImageGenerationModel
  implements ImageGenerationModel<unknown, string>
{
  readonly provider = "openrouter";
  readonly defaultModel: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: OpenRouterImageGenerationModelOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.defaultModel = options.defaultModel ?? "openai/gpt-5-image-mini";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async imageGeneration(
    request: ImageGenerationRequest,
  ): Promise<ImageGenerationResponse<unknown>> {
    const body: Record<string, unknown> = {
      model: this.defaultModel,
      prompt: request.prompt,
      size: `${request.width}x${request.height}`,
    };
    if (
      request.additionalParams !== undefined &&
      typeof request.additionalParams === "object" &&
      request.additionalParams !== null
    ) {
      Object.assign(body, request.additionalParams);
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/images`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error("Image generation temporarily unavailable");
    }

    if (!response.ok) {
      throw new Error(mapOpenRouterImageError({ status: response.status }));
    }

    const raw = (await response.json()) as {
      data?: Array<{ b64_json?: unknown; media_type?: unknown }>;
      usage?: { cost?: unknown };
    };
    const data = Array.isArray(raw.data) ? raw.data : [];
    const images: GeneratedImage[] = data.flatMap((item) => {
      if (!item || typeof item.b64_json !== "string") return [];
      const mediaType =
        typeof item.media_type === "string" ? item.media_type : undefined;
      return [{ data: Uint8Array.from(Buffer.from(item.b64_json, "base64")), mediaType }];
    });

    return {
      image: images[0]?.data ?? new Uint8Array(),
      images,
      mediaType: images[0]?.mediaType,
      rawResponse: raw,
    };
  }
}
```

**Step 3:** export from `index.ts`: add `export * from "./providers/image-generation.js";`

**Step 4:** tests green → commit.

```bash
git add packages/agent/src
git commit -m "feat(agent): openrouter image generation model (anvia semantic)"
```

---

## Task 3: Registry refactor — shared core, grants, overrides, clarification requester

**Files:**
- Modify: `apps/api/src/modules/chat/approval-registry.ts`
- Modify: `apps/api/src/modules/chat/approval-registry.test.ts`
- Test: `apps/api/src/modules/chat/clarification-registry.test.ts` (new)

**Step 1: Extract shared core.** Add private functions inside `createApprovalRegistry` (or module-level with redis param):

```ts
async function registerPending(
  redis: ApprovalRedis,
  record: { approvalId: string; userId: string; sessionId: string; streamId: string; toolName: string; args: string; reason?: string; status: "pending"; requestedAt: string },
  append: (event: unknown) => Promise<void>,
  payload: { id: string; runId?: string; agentId?: string; sessionId: string; toolName: string; callId?: string; internalCallId?: string; args: string; status: "pending"; requestedAt: string; reason?: string },
): Promise<void> {
  await redis.hset(APPROVAL_KEY(record.approvalId), record);
  await redis.expire(APPROVAL_KEY(record.approvalId), APPROVAL_TTL_SECONDS);
  await append({ type: "tool_approval_request", approval: payload });
}
```

Refactor `createHandler` to use `registerPending` + existing `waitForDecision` + result-append + cleanup. Keep the exact same event payloads so existing tests pass unchanged.

**Step 2: Add grants + overrides** (new methods on the registry return object):

```ts
const GRANT_KEY = (sessionId: string, toolName: string) => `chat-tool-grant:${sessionId}:${toolName}`;
const OVERRIDE_KEY = (sessionId: string, toolName: string) => `chat-tool-override:${sessionId}:${toolName}`;
export const GRANT_SESSION_TTL_SECONDS = 24 * 60 * 60;
export const OVERRIDE_TTL_SECONDS = 5 * 60;

// in createApprovalRegistry return:
async grantTool(input: { sessionId: string; toolName: string }): Promise<void> {
  await redis.set(GRANT_KEY(input.sessionId, input.toolName), JSON.stringify({ grantedAt: new Date().toISOString() }), "EX", GRANT_SESSION_TTL_SECONDS);
},
async hasToolGrant(sessionId: string, toolName: string): Promise<boolean> {
  return (await redis.get(GRANT_KEY(sessionId, toolName))) !== null;
},
async revokeToolGrant(sessionId: string, toolName: string): Promise<void> {
  await redis.del(GRANT_KEY(sessionId, toolName));
},
async setToolOverride(input: { sessionId: string; toolName: string; args: Record<string, unknown> }): Promise<void> {
  await redis.set(OVERRIDE_KEY(input.sessionId, input.toolName), JSON.stringify(input.args), "EX", OVERRIDE_TTL_SECONDS);
},
async takeToolOverride(sessionId: string, toolName: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(OVERRIDE_KEY(sessionId, toolName));
  await redis.del(OVERRIDE_KEY(sessionId, toolName));
  if (!raw) return null;
  try { const parsed: unknown = JSON.parse(raw); return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null; } catch { return null; }
},
```

**Step 3: Add clarification requester** (same core, separate key space):

```ts
export type ClarificationQuestion = {
  id: string; question: string;
  type: "single_choice" | "multiple_choice" | "free_text";
  options?: Array<{ id: string; label: string; recommended?: boolean }>;
  optional?: boolean; placeholder?: string;
};
export type ClarificationRequest = { title?: string; questions: ClarificationQuestion[] };
export type ClarificationResponse = {
  answers: Record<string, string | string[]>;
  skipped: string[];
  timedOut: boolean;
};
export const CLARIFICATION_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const CLARIFICATION_KEY = (id: string) => `chat-clarification:${id}`;
const CLARIFICATION_DECISION_KEY = (id: string) => `chat-clarification:${id}:decision`;

// in createApprovalRegistry return:
createClarificationRequester(input: {
  userId: string; sessionId: string; streamId: string;
  append: (event: unknown) => Promise<void>;
  timeoutMs?: number;
}): (request: ClarificationRequest) => Promise<ClarificationResponse> {
  const { userId, sessionId, streamId, append } = input;
  const timeoutMs = input.timeoutMs ?? CLARIFICATION_DEFAULT_TIMEOUT_MS;
  return async (request) => {
    const id = randomUUID();
    const requestedAt = new Date().toISOString();
    await redis.set(CLARIFICATION_KEY(id), JSON.stringify({ id, userId, sessionId, streamId, title: request.title ?? "", questions: request.questions, status: "pending", requestedAt }), "EX", APPROVAL_TTL_SECONDS);
    await append({ type: "clarification_request", clarification: { id, sessionId, title: request.title ?? "", questions: request.questions, status: "pending", requestedAt } });
    const decision = await waitForDecision(redis, id, timeoutMs); // reuse: DECISION_KEY param — see Step 4
    if (decision === "timeout") {
      await append({ type: "clarification_response", clarification: { id, status: "timed_out", resolvedAt: new Date().toISOString() } });
      await redis.del(CLARIFICATION_KEY(id));
      return { answers: {}, skipped: [], timedOut: true };
    }
    const answers = decision.answers ?? {};
    const skipped = Array.isArray(decision.skipped) ? decision.skipped : [];
    await append({ type: "clarification_response", clarification: { id, status: "answered", answers, skipped, resolvedAt: new Date().toISOString() } });
    await redis.del(CLARIFICATION_KEY(id));
    return { answers, skipped, timedOut: false };
  };
},
async publishClarificationResponse(id: string, response: { answers: Record<string, string | string[]>; skipped: string[] }): Promise<void> {
  await redis.set(CLARIFICATION_DECISION_KEY(id), JSON.stringify({ ...response, decidedAt: new Date().toISOString() }), "EX", DECISION_TTL_SECONDS);
},
async getClarification(id: string): Promise<{ userId: string; status: string } | null> {
  const raw = await redis.get(CLARIFICATION_KEY(id));
  if (!raw) return null;
  try { const parsed: unknown = JSON.parse(raw); if (!parsed || typeof parsed !== "object") return null; const rec = parsed as { userId?: unknown; status?: unknown }; return { userId: typeof rec.userId === "string" ? rec.userId : "", status: rec.status === "pending" ? "pending" : (typeof rec.status === "string" ? rec.status : "pending") }; } catch { return null; }
},
```

**Step 4: Generalize `waitForDecision`** to accept a key factory: change signature to `waitForDecision(redis, decisionKeyFn: (id: string) => string, id, timeoutMs)` — update existing call site (`DECISION_KEY`) and use `CLARIFICATION_DECISION_KEY` for clarifications. Existing tests keep passing.

**Step 5: Tests.** Extend `approval-registry.test.ts` with: grant session set/get/expire, override set/take (consumed once), approve-once does not write grant. New `clarification-registry.test.ts`: register → pending event → publish → answered event + response, skip list passthrough, timeout → `timedOut`, late publish is no-op (key gone).

**Step 6:** run `pnpm --filter api test` (all green) → commit.

```bash
git add apps/api/src/modules/chat
git commit -m "feat(api): registry core + session grants + arg overrides + clarification requester"
```

---

## Task 4: `request_clarification` tool (`packages/agent`)

**Files:**
- Create: `packages/agent/src/tools/clarification.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/src/tools/clarification.test.ts`

**Step 1: failing tests** — schema rejects >5 questions, unknown type, missing options for choice types, recommended flag allowed; execute calls requester with normalized payload and returns response; export `CLARIFICATION_INSTRUCTION` text.

**Step 2: implement:**

```ts
import { createTool } from "@anvia/core";
import z from "zod";
import type { ClarificationRequest, ClarificationResponse } from "../../../apps/api/src/modules/chat/approval-registry.js"; // see Step 3
```

> ⚠️ **Cross-package types**: do NOT import from apps/api into packages/agent (direction constraint). Define `ClarificationRequest`/`ClarificationResponse` types in `packages/agent/src/tools/clarification.ts` and have apps/api re-use them (invert dependency): apps/api imports the types from `@assingment/agent`.

```ts
export const MAX_CLARIFICATION_QUESTIONS = 5;

export type ClarificationOption = { id: string; label: string; recommended?: boolean };
export type ClarificationQuestion = {
  id: string; question: string;
  type: "single_choice" | "multiple_choice" | "free_text";
  options?: ClarificationOption[];
  optional?: boolean; placeholder?: string;
};
export type ClarificationRequest = { title?: string; questions: ClarificationQuestion[] };
export type ClarificationResponse = {
  answers: Record<string, string | string[]>;
  skipped: string[];
  timedOut: boolean;
};

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  recommended: z.boolean().optional(),
});

const questionSchema = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    type: z.enum(["single_choice", "multiple_choice", "free_text"]),
    options: z.array(optionSchema).min(2).max(8).optional(),
    optional: z.boolean().optional(),
    placeholder: z.string().max(200).optional(),
  })
  .superRefine((q, ctx) => {
    if (q.type !== "free_text" && !q.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "choice questions require options", path: ["options"] });
    }
    if (q.type === "free_text" && q.options) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "free_text must not have options", path: ["options"] });
    }
  });

const clarificationInput = z.object({
  title: z.string().min(1).max(120).optional(),
  questions: z.array(questionSchema).min(1).max(MAX_CLARIFICATION_QUESTIONS),
});

export type ClarificationToolScope = {
  requester: (request: ClarificationRequest) => Promise<ClarificationResponse>;
};

export function createClarificationTool(scope: ClarificationToolScope) {
  return createTool({
    name: "request_clarification",
    description:
      "Ask the user to clarify an uncertain request before acting. Use when the user's request is ambiguous (style, dimensions, subject, scope) or when choosing between valid options would materially change the result. You may ask up to 5 questions at once; mark recommended choices and mark optional questions you can answer yourself via the recommended choice.",
    input: clarificationInput,
    execute: async (args) => {
      const response = await scope.requester(args);
      return {
        status: response.timedOut ? "timed_out" : "answered",
        answers: response.answers,
        skipped: response.skipped,
        note: response.timedOut
          ? "The user did not respond in time; proceed using the recommended choices and your best judgment."
          : "Use the answers above; for skipped questions use the recommended choice or your best default.",
      };
    },
  });
}

export const CLARIFICATION_INSTRUCTION = [
  "You have a request_clarification tool to ask the user before acting on uncertain requests.",
  "Call it when the user's request is ambiguous: missing style, aspect ratio, subject details, or when your chosen defaults would significantly change the outcome.",
  "For every choice question mark the option you recommend; mark questions optional only if you can confidently fall back to your recommended choice.",
  "Wait for the user's answers; honor them exactly. For skipped questions use the recommended choice.",
  "Do not use request_clarification for permission — permission is handled automatically by the system.",
].join("\n");
```

**Step 3:** export from `index.ts` (`./tools/clarification.js`).

**Step 4:** green → commit.

```bash
git add packages/agent/src
git commit -m "feat(agent): generic request_clarification tool"
```

---

## Task 5: `generate_image` + `edit_image` tools (`packages/agent`)

**Files:**
- Create: `packages/agent/src/tools/image-generation.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/src/tools/image-generation.test.ts`

**Step 1: failing tests:**

- `generate_image` approval `when` → true when `!enabled && !hasGrant`, false when enabled or granted.
- Input validation: `n` capped to model capability max (e.g. n=5 on Gemini → 1); `background` rejected when model lacks it.
- Execute applies `takeToolOverride` args when present (prompt/model swapped).
- Execute calls `imageGenerationRequest(model).prompt().width().height().additionalParams().send()` (mock model) and stores every image via `scope.store.saveGeneratedImage` — n=3 → 3 store calls + metadata array with `nOfTotal: "2 of 3"`.
- Output contains only metadata (no base64).
- `edit_image` builds `input_references` with base64 data URL from `scope.resolveReference(id)` and passes via additionalParams.
- Error mapping propagates bounded strings.

**Step 2: implement** (key parts):

```ts
import { createTool, type AnyTool } from "@anvia/core";
import type { ImageGenerationModel } from "@anvia/core/image-generation";
import { imageGenerationRequest } from "@anvia/core/image-generation";
import z from "zod";
import type { GeneratedImageRecord } from "./image-store-types.js";

export type ImageGenSettings = {
  modelId?: string;
  aspectRatio?: string;
  quality?: string;
  background?: string;
  n?: number;
};

export type ImageGenerationToolScope = {
  model: ImageGenerationModel<unknown, string>;
  store: {
    saveGeneratedImage(input: {
      userId: string; sessionId: string; projectId: string | null;
      buffer: Uint8Array; mediaType: string | undefined; modelId: string;
      prompt: string; width: number; height: number; nOfTotal?: string;
    }): Promise<GeneratedImageRecord>;
  };
  enabled: boolean;
  hasGrant(toolName: string): boolean;
  takeToolOverride(toolName: string): Record<string, unknown> | null;
  userId: string; sessionId: string; projectId: string | null;
  resolveReference(imageId: string): Promise<{ mediaType: string; buffer: Uint8Array } | null>;
  capabilities: (modelId: string) => { nMax: number; background?: string[]; aspectRatios?: string[]; quality?: string[] } | null;
  defaultSettings?: ImageGenSettings;
  maxBytes?: number; // reference cap, default 10 MB
};

const generateImageInput = z.object({
  prompt: z.string().min(3).max(4000),
  modelId: z.string().optional(),
  aspectRatio: z.string().optional(),
  quality: z.string().optional(),
  background: z.string().optional(),
  n: z.number().int().min(1).max(10).optional(),
});

const editImageInput = z.object({
  prompt: z.string().min(3).max(4000),
  referenceImageId: z.string().min(1),
  modelId: z.string().optional(),
  aspectRatio: z.string().optional(),
  quality: z.string().optional(),
  background: z.string().optional(),
});

export function createImageGenerationTools(scope: ImageGenerationToolScope): AnyTool[] {
  const approval = {
    when: () => !scope.enabled && !scope.hasGrant("generate_image"),
    reason: (ctx: { args: { prompt: string } }) =>
      `The agent wants to generate an image: "${ctx.args.prompt.slice(0, 200)}"`,
    rejectMessage: "Image generation was declined by the user.",
  };
  // ... two createTool calls (generate_image, edit_image) sharing an internal
  // runGeneration(args, prompt, n) that: applies overrides, validates against
  // capabilities, resolves size from aspectRatio (via capability table),
  // calls imageGenerationRequest(...).send(), loops store.saveGeneratedImage,
  // returns metadata list. edit_image additionally resolves the reference into
  // a base64 data URL and passes input_references through additionalParams.
}
```

Aspect ratio → pixel size helper (shared, exported for UI tests):

```ts
const ASPECT_SIZES: Record<string, { width: number; height: number }> = {
  "1:1": { width: 1024, height: 1024 },
  "3:2": { width: 1152, height: 768 },
  "2:3": { width: 768, height: 1152 },
  "4:3": { width: 1152, height: 864 },
  "3:4": { width: 864, height: 1152 },
  "16:9": { width: 1344, height: 768 },
  "9:16": { width: 768, height: 1344 },
  "21:9": { width: 1344, height: 576 },
  "9:19.5": { width: 720, height: 1560 },
  "19.5:9": { width: 1560, height: 720 },
  auto: { width: 1024, height: 1024 },
};
export function aspectRatioToSize(aspectRatio?: string): { width: number; height: number } {
  return (aspectRatio && ASPECT_SIZES[aspectRatio]) ? ASPECT_SIZES[aspectRatio] : ASPECT_SIZES["auto"];
}
```

Export `IMAGE_GENERATION_INSTRUCTION` (web-search-first for visual detail, defaults from session settings, clarify ambiguity, report image ids).

**Step 3:** export from `index.ts` (`./tools/image-generation.js`).

**Step 4:** green → commit.

```bash
git add packages/agent/src
git commit -m "feat(agent): generate_image + edit_image tools with approval + overrides"
```

---

## Task 6: Image store service + `/api/images` router (`apps/api`)

**Files:**
- Create: `apps/api/src/modules/images/service.ts`
- Create: `apps/api/src/modules/images/router.ts`
- Modify: `apps/api/src/index.ts` (mount)
- Modify: `apps/api/src/modules/chat/build-run-input.ts` (inject store)
- Test: `apps/api/src/modules/images/service.test.ts` (fake R2 + fake prisma)

**Step 1: failing tests** — save → R2 put (fake `getObjectPut`-style client) + row with nOfTotal; list session/project/user scopes; `assertAccess`: owner ok, project member ok, outsider 403.

**Step 2: implement `service.ts`:**

```ts
import { prisma } from "../../utils/prisma.js";
import { getObjectPut } from "../../lib/r2.js"; // extend r2.ts with putObject helper

export type GeneratedImageRecord = {
  id: string; userId: string; projectId: string | null; sessionId: string;
  r2Key: string; mediaType: string; width: number; height: number;
  modelId: string; prompt: string; nOfTotal: string | null; createdAt: Date;
};

export async function saveGeneratedImage(input: {
  userId: string; sessionId: string; projectId: string | null;
  buffer: Uint8Array; mediaType?: string; modelId: string; prompt: string;
  width: number; height: number; nOfTotal?: string;
}): Promise<GeneratedImageRecord> {
  const r2Key = `images/${input.userId}/${crypto.randomUUID()}`;
  await putObject({ key: r2Key, body: Buffer.from(input.buffer), contentType: input.mediaType ?? "image/png" });
  return prisma.generatedImage.create({
    data: { ...input, r2Key, mediaType: input.mediaType ?? "image/png" },
  });
}

export function listSessionImages(sessionId: string) { /* prisma findMany by sessionId order desc */ }
export function listProjectImages(projectId: string) { /* by projectId */ }
export function listUserImages(userId: string) { /* by userId, projectId null */ }
export async function getImage(id: string): Promise<GeneratedImageRecord | null> { /* findUnique */ }

export async function assertImageAccess(input: { userId: string; image: GeneratedImageRecord }): Promise<boolean> {
  if (input.image.userId === input.userId) return true;
  if (!input.image.projectId) return false;
  const session = await prisma.chatSession.findFirst({
    where: { projectId: input.image.projectId, userId: input.userId },
    select: { id: true },
  });
  return session !== null;
}
```

Extend `apps/api/src/lib/r2.ts` with `putObject({ key, body, contentType })` + `getObjectBuffer` already exists.

**Step 3: router** (pattern: documents router; `requireUser`):

```ts
// GET /api/images?sessionId= | ?projectId= | ?scope=user
// GET /api/images/:id  → assertImageAccess else 403; stream R2 buffer with Content-Type; Cache-Control: private, max-age=3600
```

Mount in `apps/api/src/index.ts`: `.route("/api/images", imagesRouter)`.

**Step 4:** also inject store into `build-run-input` scope for image tools (worker passes `projectId` — add `projectId` to `ChatRunInput` already exists). Green → commit.

```bash
git add apps/api/src
git commit -m "feat(api): image store service + images router with ownership checks"
```

---

## Task 7: Chat wiring — payloads, decision routes, clarification route, capabilities

**Files:**
- Modify: `apps/api/src/modules/chat/router.ts`
- Modify: `apps/api/src/modules/chat/run-queue.ts`
- Modify: `apps/api/src/modules/chat/run-worker.ts`
- Modify: `apps/api/src/modules/chat/build-run-input.ts`

**Step 1: router.ts**
- `POST /api/chat` body: parse `imageGenerationEnabled = parseBoolean(body.imageGenerationEnabled)`; `imageGenSettings` validated with zod `ImageGenSettingsSchema` (optional object with modelId/aspectRatio/quality/background/n) — include both in `enqueueChatRun`.
- Decision route: body gains `grantScope?: "once"|"session"`, `overrideArgs?: Record<string, unknown>`; on approved + grantScope==="session" → `registry.grantTool({ sessionId: approval.sessionId, toolName: approval.toolName })`; on overrideArgs (record non-empty) → `registry.setToolOverride({ sessionId: approval.sessionId, toolName: approval.toolName, args })`; then `publishDecision` as before.
- New `POST /api/chat/clarifications/:id/response`:
  ```ts
  const record = await registry.getClarification(id);
  if (!record) return c.json({ ok: true, alreadyResolved: true });
  if (record.userId !== user.id) return c.json({ error: "forbidden", code: "FORBIDDEN" }, 403);
  if (record.status !== "pending") return c.json({ ok: true, alreadyResolved: true });
  // validate body { answers: Record<string, string|string[]>, skipped: string[] }
  await registry.publishClarificationResponse(id, { answers, skipped });
  return c.json({ ok: true });
  ```
- Capabilities: add `imageGenerationAvailable: imageGenerationConfig() !== null`.

**Step 2: run-queue.ts** — `ChatRunJobData` += `imageGenerationEnabled: boolean; imageGenSettings?: ImageGenSettings | null;`

**Step 3: run-worker.ts** — destructure new fields; build per-run helpers:

```ts
const hasGrant = (toolName: string) => registry.hasToolGrant(sessionId, toolName);
const takeToolOverride = (toolName: string) => registry.takeToolOverride(sessionId, toolName);
const clarificationRequester = registry.createClarificationRequester({ userId, sessionId, streamId, append: (event) => store.append({ streamId, event }).then(() => undefined) });
```

Pass into `buildChatRunInput` (new input fields `imageGenerationEnabled`, `imageGenSettings`, `grantHelpers: { hasGrant, takeToolOverride }`, `clarificationRequester`, plus existing `approvals`).

**Step 4: build-run-input.ts**

- New inputs: `imageGenerationEnabled?: boolean`, `imageGenSettings?: ImageGenSettings | null`, `grantHelpers?`, `clarificationRequester?`.
- `imageGenerationConfig()` helper: `{ apiKey, baseUrl }` when `OPENAI_API_KEY` + `OPENAI_BASE_URL` set (like `webSearchConfig`).
- Register image tools when config present: `createImageGenerationTools({ model: new OpenRouterImageGenerationModel(config), store: imageStore (sessionId/projectId bound), enabled: imageGenerationEnabled, hasGrant, takeToolOverride, userId, sessionId, projectId, resolveReference, capabilities: loadImageCapabilities(prisma), defaultSettings: imageGenSettings ?? undefined })`; push `IMAGE_GENERATION_INSTRUCTION`.
- Register `createClarificationTool({ requester: clarificationRequester })` when any gated tool (web or image) is present; push `CLARIFICATION_INSTRUCTION`.
- `approvals` now passed when `webSearchAvailable || imageGenerationAvailable`.
- `resolveReference`: lookup `GeneratedImage` by id OR uploaded document image (`documents/service` helper to fetch buffer by documentImageId) → return `{ mediaType, buffer }`; null when missing.

**Step 5:** run `pnpm --filter api test` + typecheck → commit.

```bash
git add apps/api/src/modules/chat
git commit -m "feat(api): wire image gen + clarification into chat runs and routes"
```

---

## Task 8: Worker-level E2E — stubbed OpenRouter server

**Files:**
- Create: `apps/api/src/modules/chat/image-generation.e2e.test.ts`
- Create: `apps/api/test/stub-openrouter.ts` (shared stub HTTP server)

**Step 1: stub server** — `node:http` server on ephemeral port:
- `POST /api/v1/images` → returns `{ data: [{ b64_json: <1x1 png base64>, media_type: "image/png" }] }` (1x1 PNG base64 constant) or configurable `n` images; records requests in an array for assertions.
- `POST /api/v1/chat/completions` or responses → returns a canned agent stream: tool call `generate_image` (toggle off → expect approval flow) → after decision, tool runs → final assistant message. (Use `@anvia/openai` responses format events — reuse patterns from existing worker tests if present; otherwise assert via registry/stream events only.)

**Step 2: E2E tests** (real Redis via docker-compose, in-memory/fake stream store + fake append recorder):

1. **Toggle off + explicit request** → `generate_image` policy suspends → approval pending event → decision `{ approved: true, grantScope: "once" }` → tool executes → image stored (fake store) → `image_generated` events appended.
2. **Allow for session** → second identical run in same session skips approval (no new pending event).
3. **Multi-image** `n: 3` → 3 store saves + 3 `image_generated` events + metadata `nOfTotal: "1 of 3"` etc.
4. **Clarification flow** → agent calls `request_clarification` → `clarification_request` event → submit `{ answers, skipped }` → `clarification_response` event → `generate_image` runs with answered params (assert stub received size/aspect from answers).
5. **Edit flow** → `edit_image` with reference → stub receives `input_references` (assert payload) → image stored.
6. **Background removed** → `background: "transparent"` + `output_format: "png"` in stub request body.

**Step 3:** run `pnpm --filter api test` → commit.

```bash
git add apps/api
git commit -m "test(api): e2e image generation flows against stubbed openrouter"
```

---

## Task 9: Frontend — capabilities, api client, collector, composer features popover

**Files:**
- Modify: `apps/platform/src/lib/api.ts`
- Create: `apps/platform/src/lib/chat/generated-images.ts`
- Modify: `apps/platform/src/lib/chat/web-sources.ts` (unchanged)
- Create: `apps/platform/src/components/composer/features-popover.tsx`
- Modify: `apps/platform/src/components/composer/chat-composer.tsx`
- Modify: `apps/platform/src/components/composer/web-search-toggle.tsx` (reuse inside popover)
- Modify: `apps/platform/src/routes/index.tsx`
- Test: `apps/platform/src/lib/chat/generated-images.test.ts`

**Step 1: api.ts additions:**

```ts
export type ImageGenSettings = { modelId?: string; aspectRatio?: string; quality?: string; background?: string; n?: number };
export type GeneratedImageMeta = { id: string; sessionId: string; projectId: string | null; mediaType: string; width: number; height: number; modelId: string; prompt: string; nOfTotal: string | null; createdAt: string };
export type ClarificationResponseBody = { answers: Record<string, string | string[]>; skipped: string[] };
export type ImageModelCatalogItem = { modelId: string; name: string; hint: string; imageCapabilities: { quality?: string[]; background?: string[]; n?: { min: number; max: number }; aspectRatios?: string[]; resolutions?: string[] } };
```

- `decideApproval({ approvalId, approved, reason?, grantScope?, overrideArgs? })` — extend existing signature (used in `routes/index.tsx:1105`).
- `submitClarification({ clarificationId, body })` → POST `/api/chat/clarifications/:id/response`.
- `fetchImageModels()` → GET `/api/models?outputType=image` (add query filter to models router `GET /api/models` in `apps/api/src/modules/models/router.ts` — filter `outputType` param) → `ImageModelCatalogItem[]`.
- `fetchSessionImages(sessionId)`, `fetchProjectImages(projectId)`, `fetchUserImages()`, `fetchImageUrl(id)` (auth — use `fetch` blob for preview).

**Step 2: `generated-images.ts` collector** (pattern `web-sources.ts`):

```ts
export type CollectedGeneratedImage = { imageId: string; sessionId: string; modelId: string; prompt: string; width: number; height: number; mediaType: string; createdAt: string };
export function collectGeneratedImages(parts: Array<{ type: string; state?: string; toolName?: string; output?: unknown }>): CollectedGeneratedImage[];
```

- Walk tool parts (`state === "output-available"`) for `generate_image`/`edit_image`; parse stringified output JSON; flatten `images[]` metadata; dedupe by imageId; skip non-image tools. Export `isImageToolName(name)`.

**Step 3: `generated-images.test.ts`** — mapping, JSON-string output, dedupe, state filter, multi-image flatten.

**Step 4: `features-popover.tsx`** — plus button (`ImagePlus` icon) → `AutoDismissPopover` with:

- `WebSearchToggle` (existing component, moved inside; disabled when `!capabilities.webSearchAvailable`).
- Image gen toggle (`role="switch"`, accent) — disabled when `!capabilities.imageGenerationAvailable`; when on, render model `Select` (from `fetchImageModels`), aspect ratio pills (from selected model `imageCapabilities.aspectRatios`), quality select, transparent-background checkbox (disabled when `!background.includes("transparent")`), n stepper (1..capability n.max).
- Props: `{ webSearchEnabled, onWebSearchToggle, imageGenerationEnabled, onImageGenerationToggle, settings, onSettingsChange, capabilities }`.
- Persist via existing `chat-preferences` (add `imageGenSettings` + `imageGenerationEnabled` keys).

**Step 5: `chat-composer.tsx`** — replace `WebSearchToggle` slot with `<FeaturesPopover … />` (keep ModelReasoningSwitcher + attach + submit layout).

**Step 6: `routes/index.tsx`** — state `imageGenerationEnabled` + `imageGenSettings` (refs like webSearchEnabled at :894-912); include in `createRequest` body (:1097); pass props to composer; wire `fetchImageModels`/capabilities.

**Step 7:** typecheck + platform tests → commit.

```bash
git add apps/platform/src
git commit -m "feat(platform): composer features popover + image api client + collector"
```

---

## Task 10: Frontend — approval panel (2 buttons + param edit + feedback)

**Files:**
- Modify: `apps/platform/src/components/chat/approval-panel.tsx`
- Modify: `apps/platform/src/routes/index.tsx` (decideApproval)

**Step 1:** extend `decideApproval` in `routes/index.tsx:1105-1126` to send `{ approved, reason?, grantScope?, overrideArgs? }`; add `useState` per approval for `grantScope` selection + override args (edit form state).

**Step 2: approval-panel.tsx** — for `generate_image`/`edit_image` approvals render editable controls (model select, aspect pills, quality select, background checkbox, n stepper) pre-filled from parsed args; prompt preview block; footer buttons:

- **Reject** (danger) — with optional feedback textarea (sent as `reason`).
- **Allow once** → `decide(approval, true, { grantScope: "once", overrideArgs })`.
- **Allow for session** → `decide(approval, true, { grantScope: "session", overrideArgs })`.
- Web-search approvals keep the existing 2-button layout (Allow maps to "once" — behavior unchanged).

Reuse `Select`/pills styling from features popover; extract a shared `ImageGenParamsEditor` component (`components/composer/image-gen-params-editor.tsx`) used by BOTH the popover and the approval card (DRY).

**Step 3:** typecheck + tests → commit.

```bash
git add apps/platform/src/components/chat apps/platform/src/routes/index.tsx apps/platform/src/components/composer/image-gen-params-editor.tsx
git commit -m "feat(platform): approval card grant scope buttons + editable image params"
```

---

## Task 11: Frontend — clarification wizard panel

**Files:**
- Create: `apps/platform/src/components/chat/clarification-panel.tsx`
- Create: `apps/platform/src/lib/chat/clarification-wizard.ts` (pure reducer — testable)
- Modify: `apps/platform/src/routes/index.tsx` (humanInput config + render)
- Test: `apps/platform/src/lib/chat/clarification-wizard.test.ts`

**Step 1: pure wizard reducer:**

```ts
export type WizardState = { step: number; answers: Record<string, string | string[]>; skipped: string[] };
export function wizardReducer(state, action: { type: "next"|"back"|"answer"|"skip"|"submit"; questionId?: string; value?: string|string[] }): WizardState
// next/back clamp [0, len-1]; skip adds questionId to skipped; answer stores value and removes from skipped;
// canSubmit(state, questions) → every question answered (in answers) or skipped
```

**Step 2: tests** — navigation, answer/skip transitions, `canSubmit` false until all resolved, submit payload.

**Step 3: `clarification-panel.tsx`** — glass card above composer (next to ApprovalPanel):

- Header: title + `Pertanyaan ${step+1} dari ${n}` + progress dots.
- Question body: single_choice → radio pills (⭐ Recommended badge), multiple_choice → checkboxes, free_text → input (placeholder).
- Optional → **Skip** button; footer **Back / Next**; last step shows **Submit** (disabled until `canSubmit`).
- `useState` wizard; on submit → `submitClarification` → pending state → error message on failure.

**Step 4: `routes/index.tsx`** — `humanInput` config gains `eventToClarification` mapping `clarification_request`/`clarification_response` events into `chat.humanInput.clarifications` (pattern of `eventToApproval`); render `<ClarificationPanel />` above composer next to `<ApprovalPanel />`.

**Step 5:** tests + typecheck → commit.

```bash
git add apps/platform/src
git commit -m "feat(platform): clarification wizard panel + human-input mapping"
```

---

## Task 12: Frontend — galleries (right rail + left sidebar) & tool activity

**Files:**
- Modify: `apps/platform/src/components/chat/session-documents-panel.tsx`
- Modify: `apps/platform/src/components/sidebar/chat-sidebar.tsx`
- Create: `apps/platform/src/components/images/image-gallery-modal.tsx`
- Modify: `apps/platform/src/components/tool-activity-panel.tsx`
- Modify: `apps/platform/src/components/tool-io-format.ts`
- Modify: `apps/platform/src/routes/index.tsx`

**Step 1: right rail** — new `CollapsibleDocumentSection` "Generated images" (ImageIcon) with 2-col grid:

- Live: derive from tool parts via `collectGeneratedImages` (memo like `webSources` at :1506) + append `image_generated`-event-derived entries; **shimmer tiles** (`skeleton-shimmer` class) while a `generate_image` tool part is `state === "running"`.
- History: on session open, `fetchSessionImages(sessionId)`.
- Auto-open rail when images exist (extend `useHasSessionDocuments` or a parallel `useHasGeneratedImages`).
- Click thumbnail → `useImagePreview()` preview.

**Step 2: left sidebar** — "Images" item below Documents with count badge → `ImageGalleryModal`:

- `fetchProjectImages(selectedProject)` / `fetchUserImages()` per filter; project filter `Select` (projects from existing sidebar state); grid 3–4 cols (`grid-cols-3`); click → preview modal; empty state.

**Step 3: tool activity** — `TOOL_LABELS` add: `generate_image: "Generating image"`, `edit_image: "Editing image"`, `request_clarification: "Asking for clarification"`; `tool-io-format.ts` add `formatGenerateImageInput/Output` + `formatEditImageInput/Output` (compact — model, ratio, quality, n, image count; never base64).

**Step 4:** tests (collector already covered) + typecheck → commit.

```bash
git add apps/platform/src
git commit -m "feat(platform): session + project image galleries and tool activity labels"
```

---

## Task 13: Models router outputType filter + capabilities UI wiring

**Files:**
- Modify: `apps/api/src/modules/models/router.ts`
- Modify: `apps/platform/src/lib/api.ts` (fetchImageModels — already in Task 9; wire catalog into popover/approval editor)

**Step 1:** `GET /api/models` accepts `?outputType=text|image` filter (default none — backward compatible).

**Step 2:** platform model catalog: `fetchImageModels()` called in features popover + approval editor (module-level cache like `fetchChatCapabilities`).

**Step 3:** verify popover disable logic: transparent-bg checkbox disabled unless `capabilities.background?.includes("transparent")`; n stepper max = `capabilities.n.max`; aspect pills from `capabilities.aspectRatios ?? ["1:1"]`.

**Step 4:** tests + typecheck → commit.

```bash
git add apps/api/src/modules/models apps/platform/src
git commit -m "feat: image model catalog filtering + capability-driven controls"
```

---

## Task 14: Browser E2E (Playwright)

**Files:**
- Create: `apps/platform/e2e/image-generation.spec.ts` (or extend `.playwright-mcp/` harness per repo convention)

**Flows (backend running + stubbed OpenRouter via env `OPENROUTER_STUB=1` flag in api):**
1. Open chat → composer shows **plus** button → popover shows Web search + Image generator toggles; enable image gen → controls appear (model select, aspect pills, bg checkbox).
2. Ask for image (toggle off) → approval card appears → **Allow once** → image appears in right-rail gallery (shimmer → thumbnail).
3. Same session, ask again → **no approval** (grant) until **Allow for session** tested separately on fresh session.
4. Card param edit: change aspect ratio → Allow → stub receives new `size`.
5. Ambiguous request with image gen on → clarification wizard: next/back, skip optional, ⭐ recommended badge, submit → generation proceeds.
6. Right-rail gallery + left sidebar Images menu → project filter → grid.
7. Background transparent checkbox enabled only for `gpt-5-image-mini`.

Run: `pnpm --filter platform e2e` (or repo Playwright command) → commit.

```bash
git add apps/platform/e2e
git commit -m "test(e2e): image generation browser flows"
```

---

## Task 15: Final verification + docs

**Step 1:** full suite:

```bash
pnpm --filter @assingment/agent test
pnpm --filter api test
pnpm --filter platform test
pnpm --filter api typecheck && pnpm --filter platform typecheck && pnpm --filter @assingment/agent typecheck
pnpm --filter api build && pnpm --filter platform build
```

**Step 2:** `pnpm --filter api prisma migrate dev` + `db seed` twice (idempotent check).

**Step 3:** update `README.md` (feature section: env reuse, image gallery, approval/clarification behavior, capability columns) + `.env.example` comments if needed.

**Step 4:** commit + open PR (per finishing-a-development-branch).

```bash
git add README.md
git commit -m "docs: image generation + human approval/clarification"
```

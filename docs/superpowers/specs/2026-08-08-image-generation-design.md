# Image Generation (OpenRouter) + Human Approval & Clarification — Design

Date: 2026-08-08
Branch: `feat/image-generation`

## 1. Goal

1. Generate images **semantically through the Anvia SDK** against **OpenRouter** (the app's existing provider base URL), using a custom `ImageGenerationModel` implementation for OpenRouter's **dedicated Image API** (`/api/v1/images`) — one endpoint for Google Gemini, OpenAI, and xAI Grok image models.
2. Two-layer human-in-the-loop, shared by **web search** (existing) and **image generation** (new):
   - **Human approval** (consent gate): tools marked "needs approval" (`web_search`, `web_fetch`, `generate_image`, `edit_image`) check a **session grant** before executing; when no grant exists, the run suspends and asks the user. Grants are per-session (Redis): **Allow once** or **Allow for session**.
   - **Human clarification** (model-initiated): a generic `request_clarification` tool the agent calls with **dynamic, multi-question** payloads (single/multiple choice with ⭐ recommended options, free text, optional questions). UI is a wizard form (step 1..n, Back/Next, Submit, Skip for optional).
3. Images are **stored server-side** (R2) with metadata in Postgres; **1 generated image = 1 generate record** even when a single tool call returns multiple images (`n > 1`).
4. **Project scope**: images generated in a project chat are visible to all sessions in that project. Galleries: right rail = session images (live during run + from history), left sidebar = **Images** menu below Documents with a **grid** + project filter.
5. **Background remover** without our own CPU/GPU: OpenRouter server-side `background: "transparent"` + `output_format: "png"` (supported by `gpt-5-image-mini`, our default; capability-driven disable for Gemini/Grok).
6. **Image editing**: `edit_image` tool using OpenRouter `input_references` (image-to-image) with user-attached images as reference; references support base64 data URLs so no public URL is needed.
7. Seed migration to **upsert** (idempotent) and to record per-model **input/output capabilities** (`outputType`, `inputModalities`, `outputModalities`, `imageCapabilities`) for both text and image models.

## 2. Research summary

### Anvia SDK (installed versions = source of truth)

- **`@anvia/core@0.16.0`** exports subpath `@anvia/core/image-generation` (confirmed in `node_modules/@anvia/core/package.json` exports + `dist/image-generation/index.d.ts`):
  - `ImageGenerationModel<RawResponse, ModelName>` interface — `imageGeneration(request: ImageGenerationRequest): Promise<ImageGenerationResponse>`.
  - `imageGenerationRequest(model)` builder: `.prompt(p).width(w).height(h).additionalParams(a).send()`.
  - `ImageGenerationResponse = { image: Uint8Array, images: GeneratedImage[], mediaType?, rawResponse }`, `GeneratedImage = { data: Uint8Array, mediaType? }`.
- **`@anvia/openai@0.4.0`** implements `OpenAIImageGenerationModel` via `client.images.generate()` (legacy OpenAI `/images/generations` path) — only OpenAI models; no `input_references`/aspect-ratio support. `OpenAIClient({ baseUrl, apiKey })` accepts any base URL.
- **`@anvia/gemini@0.4.1`** (not installed) supports Gemini image models (`gemini-2.5-flash-image`, `gemini-3.1-flash-image-preview`, etc.) but requires a direct Google API key — **not OpenRouter**. Not needed for this design.
- **Agent/tool patterns in repo**: `createTool({ name, description, input: zod, approval, execute })` (web-search.ts); approval policies `{ when(ctx), reason(ctx), rejectMessage }`; `AgentBuilder.approvals({ handler })`; tools receive services via deps injection (`createDocumentTools(deps)`, `createWebSearchTools(scope)`); single wiring point `apps/api/src/modules/chat/build-run-input.ts` for global + project chats.

### OpenRouter (docs verified 2026-08-08)

- **Dedicated Image API** `POST /api/v1/images` — single endpoint for all image models. Params: `model`, `prompt`, `n` (1–10), `resolution`/`aspect_ratio`/`size`, `quality`, `output_format` (png/jpeg/webp/svg), `background` (auto/transparent/opaque; transparent requires png/webp), `output_compression`, `seed`, `input_references` (image-to-image; URL or base64 data URL), `provider` routing. Response: `{ created, data: [{ b64_json, media_type }], usage: { cost } }`. Optional SSE streaming (`image_generation.partial_image`, `image_generation.completed`, `error`).
- **Discovery**: `GET /api/v1/images/models` + `/api/v1/images/models/:id/endpoints` — per-model `supported_parameters` (enum/range/boolean descriptors) → drives the UI controls (aspect ratios, quality, background, n range) without runtime dependency after seeding.
- **Billing**: all-or-nothing per completed generation; failed/cancelled generations not billed.
- Legacy OpenAI-compatible `POST /api/v1/images/generations` exists (route confirmed) but only serves OpenAI models — **rejected** in favor of the dedicated API.

### Selected models (cheapest latest per requested provider)

| Model | Per-image cost | Capabilities (from discovery) |
|---|---|---|
| `openai/gpt-5-image-mini` (**default**) | ~$0.008 | quality auto/low/medium/high, background auto/transparent/opaque, n 1–10, input_references ≤16, streaming, aspect via quality tiers |
| `google/gemini-3.1-flash-lite-image` | ~$0.03 | resolution 1K, aspect ratios full set, n=1, input_references ≤14, no background param |
| `x-ai/grok-imagine-image-quality` | $0.05–0.07 | resolution 1K/2K, aspect ratios incl. 19.5:9, n=1, input_references ≤3, no background param |

Background removal (`background: "transparent"`) is supported **only** by OpenAI image models — Gemini/Grok options are auto-disabled in UI via `imageCapabilities`.

### Existing infra reused

- `lib/r2.ts` (Cloudflare R2 client) — image storage; `lib/redis.ts` — grants/approvals/clarifications; `approval-registry.ts` — Redis-backed polling registry (extracted shared core); `resumable-stream-store` + JSONL SSE — stream events; `@anvia/react` `humanInput` (`eventToApproval`); `ApprovalPanel`; `SessionDocumentsPanel` right rail (+`useHasSessionDocuments`); `PopoverMenu`/`AutoDismissPopover`; `DocumentLibraryModal` (pattern for the Images gallery); `ImagePreview`; `uploadDocument` multipart flow (attached images already work — OCR pipeline); `chat-preferences.ts`; `tool-activity-panel.tsx` + `tool-io-format.ts`.

## 3. Decisions (user-confirmed)

| Topic | Decision |
|---|---|
| Generation path | OpenRouter **dedicated `/api/v1/images`** via a custom `OpenRouterImageGenerationModel implements ImageGenerationModel` (Anvia semantics, one endpoint for all providers) |
| Model catalog | `openai/gpt-5-image-mini` (default), `google/gemini-3.1-flash-lite-image`, `x-ai/grok-imagine-image-quality` — seeded with capability data; per-model settings UI rendered from `imageCapabilities` |
| Seed strategy | Switch to **upsert** (no-op when unchanged, update on change, insert new); keep prune of modelIds not in seed; providers/efforts/junctions upserted too |
| Model registry schema | `ChatModel` gains `outputType` ("text"\|"image"), `inputModalities`, `outputModalities`, `imageCapabilities` (Json) via migration; text models get their modalities backfilled |
| Approval — layer 1 | Policy consent gate per marked tool: `approval.when: () => !scope.enabled && !hasGrant(toolName)`; grants per-session in Redis; card buttons **Reject / Allow once / Allow for session**; `Allow for session` writes a session grant |
| Approval — layer 2 | Generic **`request_clarification`** tool (model-initiated, dynamic data, multi-question wizard: single/multiple choice with recommended flags, free text, optional questions); shares registry core + stream events (`clarification_request`/`clarification_response`); new decision route `POST /api/chat/clarifications/:id/response` |
| Web search unification | `web_search`/`web_fetch` move to the same grant check (toggle = initial grant; card approval can extend it); existing approval flow refactored onto the shared registry core |
| Approval-card param editing | **V1**: card edits `generate_image`/`edit_image` args (model, aspect ratio, quality, n, background); edited args sent as `overrideArgs`; registry stores `chat-tool-override:{sessionId}:{toolName}` (TTL 5 min, consumed by tool execute) |
| Storage & counting | R2 (private) + `GeneratedImage` row per image; **1 image = 1 generate** even with `n > 1`; ownership enforced on serve (owner OR project member) |
| Project scope | `GeneratedImage.projectId` (nullable); project chats share the project gallery; global chats use user scope |
| Galleries | Right rail "Generated images" (session, live + history); left sidebar **Images** menu (grid, project filter) below Documents |
| Background remover | `background: "transparent"` + `output_format: "png"` sent server-side; UI checkbox auto-disabled when model lacks `background.transparent` |
| Editing | `edit_image` tool via `input_references` (base64 data URL of attached/uploaded image or previously generated image) — in V1 |
| Capabilities endpoint | `GET /api/chat/capabilities` → adds `imageGenerationAvailable` (true when `OPENAI_API_KEY` + `OPENAI_BASE_URL` set) |
| Env | Reuse `OPENAI_API_KEY` + `OPENAI_BASE_URL` (already OpenRouter); no new keys |

## 4. Agent tools (`packages/agent`)

### `src/providers/image-generation.ts` (new)

```ts
export type OpenRouterImageGenerationModelOptions = {
  apiKey: string; baseUrl: string; defaultModel?: string;
  fetchFn?: typeof fetch;      // injectable for tests
};
export class OpenRouterImageGenerationModel implements ImageGenerationModel<unknown, string> {
  readonly provider = "openrouter";
  readonly defaultModel: string;
  async imageGeneration(request: ImageGenerationRequest): Promise<ImageGenerationResponse<unknown>>;
}
```

- POSTs to `${baseUrl}/images` with `{ model, prompt, size: `${width}x${height}`, ...additionalParams }`.
- Parses `data[].b64_json` (+ `media_type`) into `GeneratedImage[]` / `image`.
- Bounded error mapping (401/403 → not configured, 429 → rate limited, 400 → invalid params, 502 → generation failed/billing, network → unavailable). Never leak keys.
- `normalizeGeneratedImageArgs(input)` — validate/cap `n`, `aspectRatio`, `quality`, `background` against a capability set (shared with the tool + UI via seed data shape).

### `src/tools/image-generation.ts` (new)

```ts
createImageGenerationTools(scope: {
  model: ImageGenerationModel;          // OpenRouterImageGenerationModel instance
  store: GeneratedImageStore;           // injected from apps/api (R2 + DB)
  enabled: boolean;                     // per-session image-gen toggle
  hasGrant(toolName: string): boolean;  // session grant check (registry)
  takeToolOverride(toolName: string): Record<string, unknown> | null;
  defaultSettings?: ImageGenSettings;   // modelId, aspectRatio, quality, background, n
}): AnyTool[]
```

- **`generate_image`** — input `{ prompt, modelId?, aspectRatio?, quality?, background?, n? }`; approval `{ when: () => !scope.enabled && !scope.hasGrant("generate_image"), reason: "…", rejectMessage }`; execute: apply override args → call `imageGenerationRequest(model).prompt().width().height().additionalParams().send()` → for each `images[]` item: `store.saveGeneratedImage(...)` → return metadata array `{ imageId, url, width, height, mediaType, modelId, prompt, index, total }` (never base64 in context).
- **`edit_image`** — input `{ prompt, referenceImageId, modelId?, aspectRatio?, quality?, background? }`; same approval policy; execute resolves the reference (generated image or uploaded attachment) to a base64 data URL (cap ~10 MB), sends `input_references: [{ type: "image_url", image_url: { url: dataUrl } }]` via `additionalParams`, stores results like `generate_image`.
- **`IMAGE_GENERATION_INSTRUCTION`** — teach: use web search first when the prompt lacks visual detail; prefer the session default model; if the user's request is ambiguous (style, ratio, subject), call `request_clarification` with recommended defaults instead of guessing; report image ids/URLs in the answer.

### `src/tools/clarification.ts` (new) — generic human clarification

```ts
createClarificationTool(scope: {
  requester: (request: ClarificationRequest) => Promise<ClarificationResponse>;
}): AnyTool
```

- **`request_clarification`** — input:
  ```ts
  { title?, questions: [{ id, question, type: "single_choice"|"multiple_choice"|"free_text",
      options?: [{ id, label, recommended? }], optional?, placeholder? }] }  // 1..5 questions
  ```
- execute: `scope.requester(...)` → registry stores `chat-clarification:{id}`, appends `clarification_request` event, polls for `...:decision`, appends `clarification_response`, returns `{ answers: { qid: string|string[] }, skipped: string[] }` to the model; timeout → `{ timedOut: true }` and model proceeds with recommended choices.
- **`CLARIFICATION_INSTRUCTION`** — teach when to clarify (ambiguous image requests, unclear web-search scope, missing style/ratio) and that skipped optional questions fall back to recommended choices.

### `src/agent.ts`

No changes needed (approvals/instructions/tools already supported).

## 5. API (`apps/api`)

### `src/modules/chat/approval-registry.ts` (refactor + extend)

Extract a shared core used by both flows:
- `createPendingRequest(record)` → HSET + append event + `waitForDecision` (poll 500ms) + append result + cleanup. Existing `createHandler` behavior preserved (tests stay green).
- New: `createRequester(input): (request: ClarificationRequest) => Promise<ClarificationResponse>` — same core with `chat-clarification:{id}` keys, events `clarification_request`/`clarification_response`, configurable timeout (default 10 min).
- New grants: `grantTool({ userId, sessionId, toolName, scope: "once"|"session" })` (writes `chat-tool-grant:{sessionId}:{toolName}` = `{ scope, grantedAt }`, TTL 24h for session; "once" writes nothing — the decision itself approves the pending call), `hasToolGrant(sessionId, toolName)`, `revokeToolGrant`.
- New overrides: `setToolOverride({ sessionId, toolName, args })` (TTL 5 min), `takeToolOverride(sessionId, toolName)` (get + del). Overrides written by the decision route when the card sends edited args.
- `createHandler` timeout reject message becomes tool-agnostic (parameterized).

### `src/modules/chat/router.ts`

- `POST /api/chat` body gains `imageGenerationEnabled?: boolean` and `imageGenSettings?: { modelId?, aspectRatio?, quality?, background?, n? }` → job payload.
- `POST /api/chat/approvals/:approvalId/decision` — body gains `{ grantScope?: "once"|"session", overrideArgs?: Record<string, unknown>, reason? }`; on approve + grantScope="session" → write grant; on overrideArgs → write override key.
- `POST /api/chat/clarifications/:id/response` — `{ answers: Record<string, string|string[]>, skipped: string[] }`; auth + ownership like approvals; idempotent; writes decision key.
- `GET /api/chat/capabilities` → adds `imageGenerationAvailable: boolean`.

### `src/modules/images/` (new)

- `service.ts` — `GeneratedImageStore`: `saveGeneratedImage({ userId, sessionId, projectId?, buffer, mediaType, modelId, prompt, width, height, nOfTotal })` → R2 key `images/{userId}/{uuid}` + Prisma row; `listSessionImages`, `listProjectImages`, `listUserImages`, `getImage(id)`, `assertAccess(userId, image)`.
- `router.ts` (mounted at `/api/images`, `requireUser`):
  - `GET /api/images?sessionId=` | `?projectId=` | `?scope=user` → metadata lists.
  - `GET /api/images/:id` → stream from R2 with correct `Content-Type` (auth: owner OR project member; project member check via `ChatSession.projectId` membership).
- R2 client reuse `lib/r2.ts`; optional `Cache-Control: private, max-age=3600`.

### `src/modules/chat/run-worker.ts` / `run-queue.ts` / `build-run-input.ts`

- Job payload + `ChatRunJobData` gain `imageGenerationEnabled`, `imageGenSettings`.
- Worker builds: approval handler (existing), **grant/override helpers** (`hasGrant`, `takeToolOverride` bound to session), and **clarification requester** (bound to stream/append) — passed into `buildChatRunInput`.
- `buildChatRunInput` registers `generate_image`/`edit_image` (when `imageGenerationAvailable`), `request_clarification` (when any gated tool is active), instructions, `approvals` when gated tools exist, `imageGenSettings` as context for the model.

## 6. Database (`apps/api/prisma`)

### Migration (new)

- `ChatModel` += `outputType String @default("text")`, `inputModalities Json?`, `outputModalities Json?`, `imageCapabilities Json?`.
- New table `GeneratedImage`:
  ```prisma
  model GeneratedImage {
    id        String   @id @default(cuid())
    userId    String
    projectId String?
    sessionId String
    r2Key     String   @unique
    mediaType String
    width     Int
    height    Int
    modelId   String
    prompt    String
    nOfTotal  String?
    createdAt DateTime @default(now())
    @@index([userId, projectId])
    @@index([sessionId])
  }
  ```

### Seed (`prisma/seed.ts`) — upsert semantics

- Rewrite to `upsert` for providers, efforts, models, junctions (`where` on natural keys, `update` full row, `create` full row). Repeatable, no-op when unchanged.
- Add 3 image models with `outputType: "image"` + `imageCapabilities` (from OpenRouter discovery data), icon SVGs, sortOrder; backfill text models with `inputModalities`/`outputModalities`.
- Keep prune of `chatModel.modelId notIn seed` (still seed-owned).

## 7. Frontend (`apps/platform`)

### Composer

- Replace globe `WebSearchToggle` with a **plus button** → `FeaturesPopover` (new, `components/composer/features-popover.tsx`, reuses `AutoDismissPopover`):
  - Toggle **Web search** (existing behavior moved in), toggle **Image generator**.
  - When image gen on: model select (3 models + price), aspect ratio pills, quality select, transparent-background checkbox, count (n) stepper — all rendered from seeded model catalog; disabled controls per `imageCapabilities`.
  - State per session, sent with `POST /api/chat` body; persisted via existing `chat-preferences` pattern.
- Request payload builder (`routes/index.tsx` submit path) gains `imageGenerationEnabled` + `imageGenSettings`.

### Approval panel (`components/chat/approval-panel.tsx`)

- Buttons: **Reject / Allow once / Allow for session** (+ feedback textarea on reject).
- For `generate_image`/`edit_image`: editable param controls (model, aspect ratio, quality, background, n) pre-filled from `approval.args`; edits → `overrideArgs` in decision; prompt preview.
- `lib/api.ts` `decideApproval` extended with `{ grantScope?, overrideArgs?, reason? }`.

### Clarification panel (`components/chat/clarification-panel.tsx`, new)

- Wizard: header (title + "Pertanyaan 1 dari 3" + progress), single/multiple choice pills (⭐ Recommended badge), free-text input, optional → **Skip** button, footer **Back / Next / Submit**; Submit enabled when all required answered; posts `{ answers, skipped }`; loading + error states; glass styling.
- Wiring: `humanInput` config gains `eventToClarification` mapping (`clarification_request`/`clarification_response` → `chat.humanInput.clarifications`), `submitClarification` via API; rendered above composer next to `ApprovalPanel`.

### Galleries

- Right rail (`session-documents-panel.tsx`): new section **"Generated images"** — 2-col thumbnail grid; **skeleton shimmer tiles** while generating (from in-flight `generate_image` tool parts); auto-open rail when first image arrives; click → `ImagePreview`; reload from `GET /api/images?sessionId=`.
- Left sidebar (`chat-sidebar.tsx`): new **Images** item below Documents with count badge → `ImageGalleryModal` (pattern of `DocumentLibraryModal`): grid 3–4 cols, **project filter** select, click → preview; data `GET /api/images?projectId=` / `scope=user`.
- Collector: `lib/chat/generated-images.ts` (pattern of `web-sources.ts`) — from `image_generated` stream events + history API; exported pure helpers + unit tests.

### Tool activity

- `tool-activity-panel.tsx` labels: `generate_image` → "Generating image…", `edit_image` → "Editing image…", `request_clarification` → "Asking for clarification"; `tool-io-format.ts` formatters for image inputs/outputs (compact, no base64).

## 8. Testing strategy

### Unit/integration (Vitest, all offline — mocked fetch/Redis/R2)

1. **Human approval** (registry): approve once (no grant written), approve session (grant written + TTL), reject with reason, timeout auto-reject, idempotent late decisions, 403 on foreign user, corrupt decision key, overrideArgs round-trip (set + consume via `takeToolOverride`), grant expiry.
2. **Human clarification**: multi-question payload validation (max 5, types, recommended flags), wizard answer submission, skipped-optional handling (answers + skipped returned to model), timeout → `{ timedOut: true }`, idempotency, ownership check.
3. **Web search tool for image references**: model flow `web_search` → reference gathering → `generate_image` prompt enrichment (instruction-level; assert instruction text + tool registration).
4. **Upload image as reference**: attachment upload (existing flow) → `edit_image` with `referenceImageId` → base64 data URL ≤10 MB → `input_references` payload shape asserted in mocked fetch.
5. **generate_image tool**: input validation + n capped per model capabilities, override args applied, multi-image (`n: 3` → 3 `saveGeneratedImage` calls + 3 rows), output metadata (no base64), bounded error mapping, approval policy on/off with grants.
6. **edit_image tool**: reference resolution (generated image vs attachment), payload shape, background transparent + png, storage count.
7. **Background removed generation**: `background: "transparent"` + `output_format: "png"` sent; capability disable for Gemini/Grok (UI helper + tool validation).
8. **Image store & routes**: R2 mock, list session/project/user scopes, ownership (owner ok, project member ok, outsider 403), content-type streaming.
9. **Seed upsert**: run twice → unchanged rows untouched, changed rows updated, new rows inserted, retired pruned, image models + capabilities present.
10. **Frontend pure logic**: `collectGeneratedImages` (mapping, dedupe, state filter), clarification wizard reducer (back/next/skip/submit validity), approval-card override builder.

### End-to-end (offline-capable, stubbed external services)

- **Worker-level E2E** (`apps/api/src/modules/chat/` test): run the real worker pipeline with a **stubbed OpenRouter images HTTP server** (local `node:http` in test) + real Redis (docker-compose) + in-memory stream store:
  - flow: user asks for image (toggle off) → policy suspends → decision "Allow for session" → tool runs → R2/DB rows → `image_generated` events.
  - flow: multi-image `n: 3` → 3 rows, 3 events.
  - flow: ambiguous request → model (stubbed) calls `request_clarification` → submit answers → `generate_image` runs with answered params.
  - flow: `edit_image` with attached image reference + background transparent.
- **Browser E2E** (Playwright, `.playwright-mcp/` infra): composer plus popover toggles, approval card 2-button + param edit, clarification wizard (next/back/skip/submit), right-rail gallery appears during generation (shimmer → thumbnails), left sidebar Images gallery with project filter. Backend runs against stubbed OpenRouter.

## 9. Risks & guardrails

- **Cost control**: consent gate always on for image tools (toggle-off OR no grant → approval); n capped per model; approval card shows model + price hint; usage audit entry per image (existing usage module).
- **Context bloat**: base64 never returned to the model — only metadata; reference images ≤10 MB; tool output truncated.
- **Race**: concurrent approvals for same tool in one session — override key is last-write-wins + TTL 5 min (documented, accepted).
- **Security**: image serve requires ownership/project membership; R2 keys unguessable UUIDs; decision routes idempotent + 403 on mismatch; no secrets in tool output/events.
- **Provider drift**: model catalog seeded from discovery data; `imageCapabilities` stored → UI/tool validation does not depend on live OpenRouter.
- **Timeout**: approvals 5 min, clarifications 10 min → auto-resolve so runs never hang.
- **Worker restart**: pending approvals/clarifications already covered by existing fail path (registry cleanup on resolution).

## 10. Verification commands

```bash
pnpm --filter @assingment/agent test && pnpm --filter api test && pnpm --filter platform test
pnpm --filter api typecheck && pnpm --filter platform typecheck && pnpm --filter @assingment/agent typecheck
pnpm --filter api build && pnpm --filter platform build
pnpm --filter api db:migrate && pnpm --filter api db:seed   # idempotent, run twice
```
(No lint script exists in the repo — noted; if one appears, run it too.)

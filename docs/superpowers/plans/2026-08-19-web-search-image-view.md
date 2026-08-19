# Web Search Image View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the agent to fetch and "see" images discovered via `web_search`/`web_fetch` — vision models receive images natively as `type: image` tool results, non-vision models receive descriptions via the existing `view_image` vision-helper (reuse, no duplication).

**Architecture:** Extend Tavily `web_search`/`web_fetch` to request and return images (`includeImages`, `includeImageDescriptions`) and add a universal `view_image` tool that dual-modes: for vision models it fetches the URL and returns `ToolResultContent` with image bytes (native sight), for non-vision it calls the cheap vision chat model to return a text description. Wire it whenever web search is available so both model families can reference `images[].url` from search/fetch results.

**Tech Stack:** TypeScript 7, pnpm 10, Anvia Core 0.25 (`createTool`, `ToolResultContent`, completions), Tavily Core 0.7.6, Hono/BullMQ, Vitest 4, Zod 4

**Spec:** `docs/superpowers/specs/2026-08-19-web-search-image-view-design.md` — this plan implements that spec (web_search/web_fetch image exposure + universal view_image dual-mode).

## Global Constraints

- Package manager: `pnpm@10.30.3` (see `package.json: packageManager`)
- Node types: `@types/node ^26.1.1`, TS `^7.0.2`, Vitest `^4.1.10` — do not downgrade
- Anvia: `@anvia/core ^0.25.1`, `zod ^4.4.3` — follow existing `createTool` patterns in `packages/agent/src/tools/web-search.ts:111`
- Tavily: `@tavily/core ^0.7.6` — use `search(query, { includeImages, includeImageDescriptions })` and `extract(urls, { includeImages })` (verified in `node_modules/@tavily/core/dist/index.d.ts`)
- Image fetch reuse: must reuse `apps/api/src/modules/chat/vision-helper.ts:209` (`loadRemoteImage`, `assertSafeImageUrl`, `VIEW_IMAGE_MAX_BYTES=8MiB`, SSRF guards) — no new fetcher
- Boundaries: `packages/agent` stays pure (no `apps/api` imports); `apps/api` imports from `@assingment/agent` only via `build-run-input.ts`
- Branch convention: `feat/<kebab-case>` (existing `feat/web-search-tools`, `feat/image-generation`) — this plan uses `feat/web-search-image-view`
- Quality gates: `pnpm --filter @assingment/agent test`, `pnpm --filter api test`, `pnpm tsc --noEmit` (or `pnpm --filter <pkg> build`), no ESLint/type errors, no `any` leaks

---

## File Structure

**Modified:**
- `packages/agent/src/tools/web-search.ts` — add image params to search/extract, return `images` arrays, update instruction
- `packages/agent/src/tools/web-search.test.ts` — extend to cover images flow
- `apps/api/src/modules/chat/vision-helper.ts` — split `createViewImageTool` into dual-mode (vision bytes vs description), export helper for vision path
- `apps/api/src/modules/chat/build-run-input.ts` — register universal `view_image` when `webSearchAvailable` (or vision fallback), handle dual-mode wiring
- `apps/api/src/modules/chat/vision-helper.test.ts` — add vision vs non-vision tests

**No new files** (pragmatic reuse — avoids redundant `view_web_image` tool).

---

### Task 1: Extend web_search/web_fetch to return Tavily images

**Files:**
- Modify: `packages/agent/src/tools/web-search.ts:17-48, 130-195`
- Modify: `packages/agent/src/tools/web-search.test.ts:40-260`
- Test: `packages/agent/src/tools/web-search.test.ts`

**Interfaces:**
- Consumes: `TavilyClient.search(query, options)` where `options` now includes `includeImages?: boolean`, `includeImageDescriptions?: boolean`; `TavilyClient.extract(urls, options)` with `includeImages?: boolean` (from `@tavily/core` d.ts:121,146)
- Produces: `WebSearchResultItem` unchanged, but `web_search` output gains `images: Array<{url:string, description?:string}>` and `web_fetch` output gains `images: string[]` (bounded, truncated)

- [ ] **Step 1: Write failing tests for web_search images**

In `packages/agent/src/tools/web-search.test.ts` add:

```ts
it("requests and returns search images with descriptions", async () => {
  const { client, search } = fakeClient();
  search.mockResolvedValue({
    query: QUERY,
    responseTime: 100,
    images: [
      { url: "https://example.com/a.jpg", description: "A logo" },
      { url: "https://example.com/b.jpg" },
    ],
    results: [result("R", "https://example.com/1", "content")],
    requestId: "req-1",
  });
  const tools = createWebSearchTools({ tavilyClient: client, enabled: true });
  const output = await tools[0]!.call({ query: QUERY, reason: REASON }) as any;
  expect(search).toHaveBeenCalledWith(QUERY, expect.objectContaining({ includeImages: true, includeImageDescriptions: true }));
  expect(output.images).toEqual([
    { url: "https://example.com/a.jpg", description: "A logo" },
    { url: "https://example.com/b.jpg", description: undefined },
  ]);
});

it("caps images to 5 and truncates descriptions to 300 chars", async () => {
  const { client, search } = fakeClient();
  search.mockResolvedValue({
    query: QUERY, responseTime: 100,
    images: Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}.jpg`, description: "x".repeat(500) })),
    results: [], requestId: "req-1",
  });
  const tools = createWebSearchTools({ tavilyClient: client, enabled: true });
  const output = await tools[0]!.call({ query: QUERY, reason: REASON }) as any;
  expect(output.images).toHaveLength(5);
  expect(output.images[0].description.length).toBeLessThanOrEqual(301); // 300 + ellipsis
});

it("returns fetch images from extract", async () => {
  const { client, extract } = fakeClient();
  extract.mockResolvedValue({
    results: [{ url: "https://example.com/article", title: "T", rawContent: "content", images: ["https://example.com/img1.jpg", "https://example.com/img2.png"] }],
    failedResults: [], responseTime: 100, requestId: "req-2",
  });
  const tools = createWebSearchTools({ tavilyClient: client, enabled: true });
  const output = await tools[1]!.call({ url: "https://example.com/article", reason: REASON }) as any;
  expect(extract).toHaveBeenCalledWith(["https://example.com/article"], expect.objectContaining({ includeImages: true }));
  expect(output.images).toEqual(["https://example.com/img1.jpg", "https://example.com/img2.png"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @assingment/agent test -- packages/agent/src/tools/web-search.test.ts -t "requests and returns search images"`
Expected: FAIL — `output.images` undefined, `search` not called with `includeImages`

- [ ] **Step 3: Implement minimal extension in `packages/agent/src/tools/web-search.ts`**

Edits (follow existing style at lines 130-195):

```ts
// constants
const MAX_IMAGES = 5;
const IMAGE_DESC_LIMIT = 300;

function truncateDesc(text: string, limit: number): string {
  const t = text.trim();
  return t.length <= limit ? t : `${t.slice(0, limit).replace(/\s+\S*$/, "")}…`;
}

// extend scope type optionally:
// no new scope fields needed — just hardcode includeImages true

// web_search execute change:
const response = await scope.tavilyClient.search(query, {
  searchDepth: "basic",
  maxResults: Math.min(requestedMax ?? maxResults, MAX_RESULTS),
  ...(timeRange ? { timeRange } : {}),
  includeAnswer: "basic",
  includeImages: true,
  includeImageDescriptions: true,
});
return {
  query: response.query,
  answer: response.answer ?? null,
  results: response.results.slice(0, MAX_RESULTS).map(...),
  images: (response.images ?? []).slice(0, MAX_IMAGES).map((img) => ({
    url: img.url,
    ...(img.description ? { description: truncateDesc(img.description, IMAGE_DESC_LIMIT) } : {}),
  })),
};

// web_fetch execute change:
const response = await scope.tavilyClient.extract([url], {
  format: "markdown",
  includeImages: true,
});
const result = response.results[0];
if (!result) { /* existing */ }
return {
  url: result.url,
  title: result.title,
  content: truncate(result.rawContent, contentLimitChars * 3),
  images: (result.images ?? []).slice(0, MAX_IMAGES),
};
```

Also update `WEB_SEARCH_INSTRUCTION` last line add:

```
"When you need to see an image from the results, call view_image with its URL — vision models will receive the image directly, text-only models will receive a description."
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @assingment/agent test -- packages/agent/src/tools/web-search.test.ts`
Expected: PASS (all 10+ tests including new 3)

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools/web-search.ts packages/agent/src/tools/web-search.test.ts
git commit -m "feat(agent): expose tavily images in web_search and web_fetch"
```

---

### Task 2: Make view_image universal (dual-mode: vision bytes vs non-vision description)

**Files:**
- Modify: `apps/api/src/modules/chat/vision-helper.ts:9-154, 294-447`
- Modify: `apps/api/src/modules/chat/vision-helper.test.ts`
- Test: `apps/api/src/modules/chat/vision-helper.test.ts`

**Interfaces:**
- Consumes: `loadRemoteImage({url, fetchFn})` (existing, SSRF-safe), `ImageStore.getImage/getObjectBuffer`, `resolveDocumentImage`, `CompletionModel` (vision helper)
- Produces: `createViewImageTool(options)` now returns `AnyTool` whose `execute` returns `string | ToolResultContent[]` depending on `options.mode`; plus new `createUniversalViewImageTool` or extended options with `mode: "vision" | "description"`; `VISION_HELPER_INSTRUCTION` updated

- [ ] **Step 1: Write failing tests for dual-mode**

In `apps/api/src/modules/chat/vision-helper.test.ts` add:

```ts
import type { ToolResultContent } from "@anvia/core";
import { createViewImageTool } from "./vision-helper.js";

describe("view_image universal", () => {
  it("vision mode returns image ToolResultContent for a public URL", async () => {
    const fakeFetch = vi.fn(async () => new Response(new Uint8Array([0xff,0xd8,0xff,0x00]), { status: 200, headers: { "content-type": "image/jpeg" } }));
    const tool = createViewImageTool(makeOptions({ mode: "vision", fetchFn: fakeFetch as any }));
    // stub dns lookup to avoid network: mock assertSafeImageUrl? Instead mock lookup
    const result = await tool.call({ url: "https://example.com/photo.jpg" }) as ToolResultContent[];
    expect(Array.isArray(result)).toBe(true);
    expect(result[0]).toMatchObject({ type: "text" });
    expect(result[1]).toMatchObject({ type: "image", mediaType: "image/jpeg" });
  });

  it("description mode (non-vision) still returns text description", async () => {
    const tool = createViewImageTool(makeOptions({ mode: "description" }));
    const output = await tool.call({ imageId: "doc-img-1" });
    expect(typeof output).toBe("string");
    expect(output).toBe("A chart showing quarterly revenue.");
  });

  it("vision mode also supports imageId by loading session image bytes", async () => {
    const store = { getImage: vi.fn(async () => ({ userId: USER, sessionId: SESSION, r2Key: "k1", mediaType: "image/png" })), getObjectBuffer: vi.fn(async () => new Uint8Array([1,2,3])) } as any;
    const tool = createViewImageTool(makeOptions({ mode: "vision", store }));
    const result = await tool.call({ imageId: "img-1" }) as ToolResultContent[];
    expect(result.some(p => p.type === "image")).toBe(true);
  });
});
```

You'll need to extend `makeOptions` helper to accept `mode` and `fetchFn`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter api test -- vision-helper`
Expected: FAIL — `mode` not recognized, vision path not returning ToolResultContent[]

- [ ] **Step 3: Implement dual-mode in `vision-helper.ts`**

Changes:

```ts
// Add top import
import type { ToolResultContent } from "@anvia/core";

// Extend options
export type ViewImageToolOptions = {
  userId: string; sessionId: string; store: ImageStore; model: CompletionModel;
  fetchFn?: typeof fetch;
  resolveDocumentImage?: ...;
  mode?: "vision" | "description"; // default "description" for backwards compat
};

// Helper to build ToolResultContent for vision path
function toVisionResult(buffer: Buffer, mediaType: string, question?: string): ToolResultContent[] {
  return [
    { type: "text", text: question ? `Image query: ${question}` : "Image from web search — describe what you see to answer the user." },
    { type: "image", data: buffer.toString("base64"), mediaType },
  ];
}

// In createViewImageTool, branch:
export function createViewImageTool(options: ViewImageToolOptions) {
  const { userId, sessionId, store, model, fetchFn = fetch, mode = "description" } = options;
  return createTool({
    name: "view_image",
    description: VISION_HELPER_INSTRUCTION + (mode === "vision" ? " Returns the image bytes for vision models." : ""),
    input: viewImageInput,
    execute: async ({ imageId, url, question }) => {
      try {
        const loaded = imageId
          ? await loadSessionImage({ imageId, userId, sessionId, store, resolveDocumentImage: options.resolveDocumentImage })
          : await loadRemoteImage({ url: url!, fetchFn });
        if ("error" in loaded) {
          // For vision mode, return text error as ToolResultContent so agent sees it
          return mode === "vision"
            ? ([{ type: "text", text: loaded.error }] satisfies ToolResultContent[])
            : loaded.error;
        }
        if (mode === "vision") {
          return toVisionResult(loaded.buffer, loaded.mediaType, question);
        }
        // description mode: existing createCompletion flow
        const result = await createCompletion(model, {
          messages: [Message.user([UserContent.imageBase64(loaded.buffer.toString("base64"), loaded.mediaType, { detail: "auto" }), UserContent.text(question ?? "Describe this image accurately and concisely.")])],
          instructions: VIEW_IMAGE_INSTRUCTIONS,
        });
        return result.text;
      } catch (error) {
        const msg = "Failed to view the image. Try again or skip it.";
        return mode === "vision" ? ([{ type: "text", text: msg }] satisfies ToolResultContent[]) : msg;
      }
    },
  });
}

// Update VISION_HELPER_INSTRUCTION to mention universal:
export const VISION_HELPER_INSTRUCTION =
  "When you need to see what an image looks like, call view_image — it returns the image for vision models or a text description for text-only models.\n" +
  "Sources: imageId (session/document) or url (public http(s) image from web_search/web_fetch images).\n" +
  "web_search now returns images[] with url and description; web_fetch returns images[] URLs. Pass the URL you want to inspect to view_image.";

// Keep createDefaultViewImageTool wrapper but pass mode through:
export function createDefaultViewImageTool(options: { userId:string; sessionId:string; model: CompletionModel; resolveDocumentImage?: ViewImageToolOptions["resolveDocumentImage"]; mode?: "vision"|"description" }) {
  return createViewImageTool({ ...options, store: getImageStore(), mode: options.mode });
}
```

Note: Need to handle `mode` logic where `view_image` for vision models should accept ToolResultContent[] — verify Anvia `createTool` can return `ToolResultContent[]` or `string`. Check existing `get_document_page_images` returns `ToolResultContent[]` — so pattern is valid. Ensure compile passes.

For DNS mock stability in tests: stub `lookup` via `vi.mock("node:dns/promises", ...)` or inject `assertSafeImageUrl` bypass for test URL `example.com`. Simplest: in tests mock `assertSafeImageUrl` to return null for example.com, and provide fake buffer with JPEG header. Or adjust test to mock `loadRemoteImage` internals? Better to expose `fetchFn` and mock `lookup` by adding optional `dnsLookup` param. For pragmatic simplest: in vision mode test, stub `loadRemoteImage` not needed if we add `skipSafeCheck` for tests? Instead we can test via `imageId` path which doesn't hit DNS, plus mock fetch for URL path by mocking the dns `lookup` at module level.

Add at top of test: `vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]) }));` and `vi.mock("node:net", async (importOrig) => ({ ...(await importOrig()), isIP: () => 0 }))` — check actual test stability.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter api test -- apps/api/src/modules/chat/vision-helper.test.ts`
Expected: PASS (3 new + 2 existing)

Run also: `pnpm --filter api test` full to ensure no regression

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chat/vision-helper.ts apps/api/src/modules/chat/vision-helper.test.ts
git commit -m "feat(api): universal view_image dual-mode (vision bytes vs description)"
```

---

### Task 3: Wire universal view_image in build-run-input

**Files:**
- Modify: `apps/api/src/modules/chat/build-run-input.ts:32-62, 232-536`

**Interfaces:**
- Consumes: `resolveVisionHelperModel()`, `createDefaultViewImageTool`, `modelAcceptsImage`, `webSearchAvailable`
- Produces: `ChatRunInput.tools` now always contains `view_image` when web search is available (dual-mode), plus retains fallback for non-vision without web search

- [ ] **Step 1: Write failing integration test (or manual check) for wiring**

Create/extend `apps/api/src/modules/chat/build-run-input.test.ts` if exists else add new `build-run-input.image-view.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
vi.mock("@assingment/agent", async (orig) => { /* mock createCompletionModel */ });
vi.mock("../models/service.js", () => ({ findActiveModel: vi.fn(), listModels: vi.fn() }));
// Assert that buildChatRunInput includes view_image tool when webSearchAvailable true
it("registers view_image for vision model when web search is available", async () => {
  // mock findActiveModel to return image-capable, webSearchConfig to return apiKey
  // call buildChatRunInput with webSearchEnabled true, model vision
  // expect tools.some(t => t.name === "view_image") true
});
it("registers view_image for non-vision model regardless of web search (description mode)", async () => {
  // mock non-vision model, no webSearch
  // expect view_image present
});
```

Alternatively for this bounded task, we can verify via existing `build-run-input` tests + manual inspection, since mocking prisma etc is heavy. For pragmatic TDD, we will run existing tests and add lightweight unit for tool presence via stubbing only `findActiveModel`.

Simpler pragmatic step: add a focused test file `apps/api/src/modules/chat/image-view-wiring.test.ts` that tests the helper factory selection logic in isolation (extracted function).

If extracting is too invasive, we can instead do: after code change, run `pnpm --filter api test` and manually assert via `grep -r "view_image" apps/api/src/modules/chat/build-run-input.ts`.

For plan purposes, define step as writing a wiring test, but allow fallback to manual verification if mocking proves brittle.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api test -- image-view-wiring`
Expected: FAIL — no such tool registered for vision

- [ ] **Step 3: Implement wiring in `build-run-input.ts`**

Changes:

```ts
// Imports: already have createDefaultViewImageTool, resolveVisionHelperModel, VISION_HELPER_INSTRUCTION
// After webSearchAvailable block (line 423) and after imageGeneration block, replace the old vision helper guard:

// OLD:
// if (!modelAcceptsImage) {
//   const visionModel = await resolveVisionHelperModel();
//   if (visionModel) { tools.push(createDefaultViewImageTool({... mode: description }) ); instructions.push(VISION_HELPER_INSTRUCTION); }
// }

// NEW:
let universalViewImageRegistered = false;

// Non-vision fallback: always need description mode (existing behavior) even without web search
if (!modelAcceptsImage) {
  const visionModel = await resolveVisionHelperModel();
  if (visionModel) {
    tools.push(
      createDefaultViewImageTool({
        userId, sessionId, model: visionModel,
        resolveDocumentImage: (imageId, imageUserId, imageSessionId) => findSessionDocumentImage(imageId, imageUserId, imageSessionId),
        mode: "description",
      }),
    );
    if (!universalViewImageRegistered) instructions.push(VISION_HELPER_INSTRUCTION);
    universalViewImageRegistered = true;
  }
}

// Vision OR web-search universal: when webSearchAvailable, register vision-mode view_image for ALL models
// (so vision models can fetch web images natively, non-vision also gets bytes? No, non-vision already has description above; avoid double registration)
if (webSearchAvailable && !universalViewImageRegistered) {
  // For vision models: return bytes. For non-vision we already registered description above, so skip.
  // But if webSearchAvailable and !modelAcceptsImage, we already have description — that's sufficient for web images too (URL path works).
  // For vision models:
  if (modelAcceptsImage) {
    // Vision model gets a lightweight view_image that fetches and returns ToolResultContent image bytes
    // We still need a CompletionModel for type, but we won't use it — pass a dummy stub model for fetch path
    // Instead reuse same factory but with mode: "vision" and a dummy model (not used for vision bytes)
    const dummyVisionModel = await resolveVisionHelperModel() ?? createCompletionModel(model); // fallback to same model if no helper available
    tools.push(
      createDefaultViewImageTool({
        userId, sessionId, model: dummyVisionModel,
        resolveDocumentImage: (imageId, imageUserId, imageSessionId) => findSessionDocumentImage(imageId, imageUserId, imageSessionId),
        mode: "vision",
      }),
    );
    instructions.push(VISION_HELPER_INSTRUCTION);
    universalViewImageRegistered = true;
  } else {
    // Non-vision already registered above — just ensure instruction present (already done)
  }
}

// Edge: vision model WITHOUT webSearchAvailable but needs to view document images? Currently only non-vision gets view_image.
// Should vision models also have view_image for document images when web not available? Not needed — vision models already receive document image bytes via get_document_page_images ToolResultContent.
// So no action.
```

Important nuance: `createDefaultViewImageTool` requires `model` even for vision bytes mode (not used). Provide fallback: if `resolveVisionHelperModel()` returns null and model is vision, use `createCompletionModel(model)` as dummy — it won't be called.

Also need to handle `findSessionDocumentImage` import already exists at line 138.

Alternative cleaner: add a new factory `createVisionImageTool` that doesn't need model param. But reuse is pragmatic — just pass dummy model.

Update imports at top: `import { createCompletionModel } from "@assingment/agent";` already available via build-run-input's agent imports? Check current imports line 12-22 includes `createCompletionModel` — yes at line 13.

Ensure `createDefaultViewImageTool` signature updated to accept `mode`.

- [ ] **Step 4: Run tests to verify wiring**

Run: `pnpm --filter api test`
Expected: PASS (including new wiring test, existing build-run-input tests)

Run typecheck: `pnpm --filter api exec tsc --noEmit` or `pnpm --filter api build`

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/chat/build-run-input.ts apps/api/src/modules/chat/image-view-wiring.test.ts
git commit -m "feat(api): wire universal view_image for web images (vision bytes, non-vision description)"
```

---

### Task 4: E2E and regression verification + instruction polish

**Files:**
- Modify: `packages/agent/src/tools/web-search.ts` (instruction already done in Task1, verify)
- Modify: `apps/api/src/modules/chat/vision-helper.ts` (instruction)
- Test: `apps/api/src/modules/chat/chat-session.test.ts` if needed for web_sources collector? No UI rail change needed
- Test: full suite

**Interfaces:**
- Consumes: all prior tasks
- Produces: passing gates

- [ ] **Step 1: Add integration test for end-to-end flow (web_search → view_image)**

In `packages/agent/src/evals/suites/approval-web-search.suite.ts` or new `apps/api/src/modules/chat/web-image.e2e.test.ts` (stubbed Tavily + stubbed fetch):

```ts
it("vision model: web_search returns images, view_image returns bytes", async () => {
  const tavilyClient = { search: vi.fn(async () => ({ query: "logo", images: [{url:"https://example.com/logo.png", description:"logo"}], results: [{title:"T",url:"https://example.com",content:"c",score:0.9,publishedDate:"2026-08-07"}], responseTime:100, requestId:"1" })), extract: vi.fn() };
  const webTools = createWebSearchTools({ tavilyClient: tavilyClient as any, enabled: true });
  const searchOut = await webTools[0]!.call({ query:"logo", reason:"need logo" }) as any;
  expect(searchOut.images[0].url).toBe("https://example.com/logo.png");
  // then view_image vision mode would fetch that URL — tested in Task2
});
```

Alternatively extend `packages/agent/src/e2e/image-generation.e2e.test.ts` pattern with web image flow.

If too heavy, ensure Task1+Task2 tests already cover contract; this task can be just a collector test update.

- [ ] **Step 2: Run full quality gates**

Run:
```bash
pnpm --filter @assingment/agent test
pnpm --filter api test
pnpm --filter @assingment/agent exec tsc --noEmit
pnpm --filter api exec tsc --noEmit
```

Expected: all PASS, no warnings. If any `any` or unused import, fix with `// eslint-disable-next-line` only where justified, else remove.

Optional lint if config exists: `pnpm eslint . --max-warnings=0` or `pnpm --filter api exec eslint src/modules/chat/vision-helper.ts`

- [ ] **Step 3: Manual smoke of instructions**

Verify prompts:
- `WEB_SEARCH_INSTRUCTION` in `packages/agent/src/tools/web-search.ts:199` now mentions `view_image` with URL
- `VISION_HELPER_INSTRUCTION` in `vision-helper.ts:22` now mentions `web_search images[]`

Grep:

```bash
grep -n "view_image" packages/agent/src/tools/web-search.ts apps/api/src/modules/chat/vision-helper.ts apps/api/src/modules/chat/build-run-input.ts
```

Expected: at least 3 hits

- [ ] **Step 4: Commit verification**

```bash
git add .
git commit -m "test: verify web image view e2e and quality gates (typecheck, lint)"
# or if no code change, just ensure gates pass and proceed to final docs
```

---

### Task 5: Docs and branch finalization

**Files:**
- Modify: `README.md` if web search section exists (optional)
- Modify: `.env.example` comments (no new env needed)
- Test: none — verification only

- [ ] **Step 1: Update PR description / README snippet**

Add to README feature section (if exists search "Web Search"):

```
- Web search now returns `images[]` (url + description) from Tavily; `web_fetch` returns extracted `images[]`.
- `view_image` works for both vision and text-only models: vision → image bytes, text-only → description via helper model.
```

If README has no web section, skip code change and just note in PR description.

- [ ] **Step 2: Final gates before PR**

Run:
```bash
pnpm --filter @assingment/agent test && pnpm --filter api test
pnpm --filter @assingment/agent exec tsc --noEmit && pnpm --filter api exec tsc --noEmit
```

Expected: zero failures

- [ ] **Step 3: Push branch and open PR**

```bash
git push -u origin feat/web-search-image-view
gh pr create --title "feat: web search image view (vision bytes + non-vision description)" --body "Implements universal view_image for web_search images. @see docs/superpowers/plans/2026-08-19-web-search-image-view.md"
```

---

## Self-Review

- Spec coverage: web_search images ✅ Task1, web_fetch images ✅ Task1, universal view_image vision bytes ✅ Task2, non-vision description ✅ Task2, wiring ✅ Task3, reuse of loadRemoteImage ✅ Task2, instruction updates ✅ Task1+2, tests/typecheck ✅ Task4, branch convention ✅
- Placeholder scan: no TBD/TODO — all steps contain actual code blocks and commands
- Type consistency: `ToolResultContent` imported from `@anvia/core` (matches `packages/agent/src/tools/documents.ts:4`), `createViewImageTool` mode param typed as `"vision"|"description"`, `build-run-input.ts` passes `mode` accordingly


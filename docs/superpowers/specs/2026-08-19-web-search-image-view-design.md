# Web Search Image View — Design

Date: 2026-08-19
Branch: `feat/web-search-image-view`

## 1. Goal

Enable the agent to fetch and "see" images discovered via web search:

1. `web_search` returns related images (`images: { url, description }[]`) from Tavily `search` with `includeImages` + `includeImageDescriptions`.
2. `web_fetch` returns page images (`images: string[]`) from Tavily `extract` with `includeImages`.
3. A universal `view_image` tool lets the agent inspect any web image URL: **vision models receive image bytes natively** (`ToolResultContent` `{type:"image"}`), **non-vision (text-only) models receive a text description** via the cheap vision helper chat model (sub-agent-as-tool pattern already in `vision-helper.ts`).
4. Pragmatic reuse: no new fetcher or duplicate SSRF logic — extend `loadRemoteImage`/`assertSafeImageUrl` in `apps/api/src/modules/chat/vision-helper.ts:209` and wire in `build-run-input.ts:482`.

## 2. Research summary

- **Tavily Core 0.7.6** already installed (`packages/agent/node_modules/@tavily/core`): `TavilySearchOptions.includeImages` + `includeImageDescriptions` (d.ts:121), `TavilySearchResponse.images: Array<{url, description?}>`, `TavilyExtractOptions.includeImages` (d.ts:146), `TavilyExtractResult.images?: string[]`. Verified via `cat node_modules/@tavily/core/dist/index.d.ts | head -300`.
- **Current web_search** (`packages/agent/src/tools/web-search.ts:133-153`): calls `client.search(query, {searchDepth:"basic", maxResults, includeAnswer:"basic"})` but never `includeImages`; `response.images` ignored; `web_fetch` (`:167`) calls `client.extract([url], {format:"markdown"})` without `includeImages`; no image exposure.
- **vision-helper** (`apps/api/src/modules/chat/vision-helper.ts:109-291`): `createViewImageTool(options:{userId,sessionId,store,model,fetchFn})` supports `imageId` (session `ImageStore` or document R2 via `resolveDocumentImage`) and `url` (public http(s) with SSRF guards `assertSafeImageUrl`, `isBlockedHostname/Ip`, `MAX_REDIRECTS=3`, `FETCH_TIMEOUT_MS=15s`, `VIEW_IMAGE_MAX_BYTES=8MiB`, magic-byte sniff). Registered only when `!modelAcceptsImage` (`build-run-input.ts:482`), with `VISION_HELPER_INSTRUCTION` already mentioning public URLs. Vision models have no view path for web images.
- **Document images** (`packages/agent/src/tools/documents.ts:405`): `get_document_page_images` already returns `ToolResultContent[]` (`{type:"text", text:JSON}` + `{type:"image", data:base64}`) for vision models and metadata-only for non-vision — same multi-part pattern can be reused for web images.
- **Anvia ToolResultContent**: `createTool` may return `string` or `ToolResultContent[]`; `satisfies ToolResultContent[]` used in docs tools — vision models will receive inline image bytes.

## 3. Decisions (user-confirmed 2026-08-19)

| Topic | Decision |
|---|---|
| Image source | Tavily `includeImages:true` for both tools; cap `MAX_IMAGES=5` (reuse `MAX_RESULTS` bound), truncate descriptions to 300 chars |
| View tool reuse | Extend existing `view_image` (no new `view_web_image`) — dual-mode via `mode: "vision" \| "description"` |
| Vision path | Fetch URL via `loadRemoteImage` (reuse SSRF guards) → return `[ {type:"text", text: questionOrDefault }, {type:"image", data:base64, mediaType} ]` |
| Non-vision path | Existing flow: `loadRemoteImage` → `createCompletion(visionModel, {messages:[UserContent.imageBase64(...), UserContent.text(question)]})` → return `result.text` |
| Wiring | Register `view_image` universally when `webSearchAvailable` (vision → bytes mode) plus keep non-vision fallback even without web search (document images). Single wiring point `build-run-input.ts` |
| Instruction | Update `WEB_SEARCH_INSTRUCTION` and `VISION_HELPER_INSTRUCTION` to mention `images[]` + `view_image(url)` flow |
| Fetch pragmatics | Reuse `loadRemoteImage` (8 MiB cap, 15s timeout, 3 redirects, SSRF) — no new infra, no R2 write for web images (transient, returned inline) |
| Testing | Extend `web-search.test.ts` (image caps), `vision-helper.test.ts` (dual-mode), plus wiring check in `build-run-input`; **E2E wajib via Playwright browser (hands-on)** — setiap case dicek langsung di browser (bukan hanya mock), lihat `apps/platform/e2e/web-search-image-view.e2e.ts`; keep existing gates green |
| E2E hands-on | Setiap perubahan di Task 1-3 harus diverifikasi **hands-on via `playwright_browser_*` tools** (real browser, bukan hanya `pnpm test`): buka `http://localhost:3000`, cek web_search images muncul, cek view_image vision vs non-vision, cek error paths; semua case harus PASS sebelum commit final |

## 4. Agent tools (`packages/agent`)

### `src/tools/web-search.ts`

```ts
const MAX_IMAGES = 5;
const IMAGE_DESC_LIMIT = 300;
function truncateDesc(text: string, limit: number): string { /* trim, slice, ellipsis */ }

createWebSearchTools(scope: {
  tavilyClient: TavilyClient;
  enabled: boolean;
  maxResults?: number;
  contentLimitChars?: number;
}): AnyTool[]
```

- `web_search` execute: `client.search(query, { searchDepth:"basic", maxResults, timeRange?, includeAnswer:"basic", includeImages:true, includeImageDescriptions:true })` → return `{ query, answer, results: [...], images: response.images.slice(0,5).map(({url, description}) => ({url, description: truncateDesc(description)})) }`.
- `web_fetch` execute: `client.extract([url], { format:"markdown", includeImages:true })` → return `{ url, title, content: truncate(rawContent), images: (result.images ?? []).slice(0,5) }`.
- `WEB_SEARCH_INSTRUCTION` append: "When you need to see an image from the results, call view_image with its URL — vision models will receive the image directly, text-only models will receive a description."

### Error bounds

Reuse `mapTavilyError` (401/403 → config, 429 → rate limit, 400 → query) — images being empty is not an error.

## 5. API (`apps/api`)

### `src/modules/chat/vision-helper.ts`

```ts
export type ViewImageToolOptions = {
  userId: string; sessionId: string; store: ImageStore; model: CompletionModel;
  fetchFn?: typeof fetch;
  resolveDocumentImage?: (imageId:string,userId:string,sessionId:string)=>Promise<{mediaType:string,buffer:Uint8Array}|null>;
  mode?: "vision" | "description"; // default "description" for back-compat
};

export function createViewImageTool(options: ViewImageToolOptions): AnyTool {
  // shared input schema viewImageInput (imageId xor url)
  // execute: load via loadSessionImage or loadRemoteImage → if error return text or [text] based on mode
  // if mode==="vision" → return ToolResultContent[] [text, image]
  // else → createCompletion(visionModel, imageBase64) → return string
}

export function createDefaultViewImageTool(options:{userId,sessionId,model,resolveDocumentImage?,mode?}) {
  return createViewImageTool({ ...options, store: getImageStore() });
}

export const VISION_HELPER_INSTRUCTION =
  "When you need to see what an image looks like, call view_image — it returns the image for vision models or a text description for text-only models.\n" +
  "Sources: imageId (session/document) or url (public http(s) image from web_search/web_fetch images).\n" +
  "web_search now returns images[] with url and description; web_fetch returns images[] URLs. Pass the URL you want to inspect to view_image.";
```

- Keep `loadRemoteImage`, `assertSafeImageUrl`, `isBlockedHostname/Ip`, `sniffImageMediaType`, `VIEW_IMAGE_MAX_BYTES`, `FETCH_TIMEOUT_MS`, `MAX_REDIRECTS` unchanged — reuse.
- Dual-mode return type relies on Anvia supporting `ToolResultContent[]` (verified in `documents.ts:447`).

### `src/modules/chat/build-run-input.ts`

- New wiring (single place, ~line 482):

```ts
let universalViewImageRegistered = false;
if (!modelAcceptsImage) {
  const visionModel = await resolveVisionHelperModel();
  if (visionModel) {
    tools.push(createDefaultViewImageTool({ userId, sessionId, model: visionModel, resolveDocumentImage: findSessionDocumentImage, mode: "description" }));
    instructions.push(VISION_HELPER_INSTRUCTION);
    universalViewImageRegistered = true;
  }
}
if (webSearchAvailable && !universalViewImageRegistered) {
  if (modelAcceptsImage) {
    const dummyModel = await resolveVisionHelperModel() ?? createCompletionModel(model);
    tools.push(createDefaultViewImageTool({ userId, sessionId, model: dummyModel, resolveDocumentImage: findSessionDocumentImage, mode: "vision" }));
    instructions.push(VISION_HELPER_INSTRUCTION);
    universalViewImageRegistered = true;
  }
}
```

- Vision models without web search keep document image path via `get_document_page_images` bytes — no view_image needed.
- Non-vision with web search already has description mode — URL fetch works.

## 6. Platform

No UI change required for v1. Web sources rail (`apps/platform/src/lib/chat/web-sources.ts`) could later surface `images` thumbnails, but out of scope — agent references URLs in chat citations.

## 7. Error handling / edge cases

- Tavily with `includeImages:true` still returns `images: []` when none found — handled as empty array, not an error.
- `loadRemoteImage` failures (SSRF block, DNS private, timeout, >8 MiB, non-image content-type) → return bounded text error (`"That image host is not allowed."`, `"Could not download the image (HTTP 404)."`, etc.) — for vision mode wrapped as `[{type:"text", text:error}]` so agent can surface it.
- Redirect loops (`MAX_REDIRECTS=3`) → `"Image URL redirected too many times."`
- Non-image URLs from Tavily (e.g. favicon mis-tagged) rejected by `sniffImageMediaType` / content-type check.
- No R2 persistence for web images — transient inline bytes keep storage bounded; session/document images still via R2.

## 8. Testing

- `packages/agent/src/tools/web-search.test.ts`: new cases — search sends `includeImages/includeImageDescriptions`, caps to 5 and truncates desc; fetch sends `includeImages` and returns `images`.
- `apps/api/src/modules/chat/vision-helper.test.ts`: dual-mode — vision `url` returns `[text,image]` content, vision `imageId` returns image, description mode returns string; SSRF/dns mocked via `vi.mock("node:dns/promises")`.
- `apps/api/src/modules/chat/build-run-input.test.ts` or new `image-view-wiring.test.ts`: assert `view_image` present for vision+webSearch and non-vision cases.
- Existing suites must stay green: `pnpm --filter @assingment/agent test`, `pnpm --filter api test`.
- **E2E via Playwright browser (hands-on, wajib)** — buat `apps/platform/e2e/web-search-image-view.e2e.ts` (reuse `e2e/stub-openrouter.ts` + `playwright.config.ts:19` webServer). Cases dicek langsung via `playwright_browser_navigate`, `snapshot`, `click`, `network_requests`:
  1. Vision: `web_search` kirim `images[]` → agent panggil `view_image(url)` → inline image bytes terlihat di chat/bubble (verifikasi via browser snapshot, bukan cuma stub).
  2. Non-vision: `view_image(url)` return description text (stub vision helper) → cek pesan agent mengandung deskripsi, bukan image bytes.
  3. Error paths: SSRF block / 404 / >8MiB → bounded error text muncul di tool result, agent surface error tanpa crash.
  4. `web_fetch` images → `view_image` dari extract `images[]` juga works.
  5. Hands-on gate: setiap Task 1-3 selesai, jalankan `pnpm --filter platform exec playwright test e2e/web-search-image-view.e2e.ts` + manual `playwright_browser_*` cek di `http://localhost:3000` sebelum lanjut task berikutnya.

## 9. Verification

- `pnpm --filter @assingment/agent exec tsc --noEmit` and `pnpm --filter api exec tsc --noEmit` (no type errors)
- `pnpm --filter @assingment/agent test` and `pnpm --filter api test` (0 failures)
- `pnpm --filter platform exec playwright test e2e/web-search-image-view.e2e.ts` (atau `pnpm exec playwright test` via `apps/platform/playwright.config.ts`) — semua 5 E2E cases PASS; trace on retry tersedia
- **Hands-on browser check (wajib per case)** — via `playwright_browser_navigate` ke `http://localhost:3000`, `playwright_browser_snapshot` cek composer, `playwright_browser_network_requests` cek `includeImages` payload, `playwright_browser_evaluate` cek DOM image render; fail → perbaiki sebelum commit
- Grep: `grep -rn "view_image" packages/agent/src/tools/web-search.ts apps/api/src/modules/chat/vision-helper.ts apps/api/src/modules/chat/build-run-input.ts` → ≥3 hits
- Manual (with `TAVILY_API_KEY`): `web_search "logo of vercel"` → `images[0].url` → `view_image(url)` → vision sees image / non-vision gets description.

## 10. Alternatives considered

- Separate `view_web_image` tool: rejected — duplicates `view_image` URL support already present; single tool keeps instruction surface small.
- Persist web images to R2 + gallery: deferred — adds storage + ownership complexity for transient references; inline bytes sufficient for v1.
- Return base64 for web_fetch images directly: rejected — would blow up tool result size; on-demand `view_image` keeps costs low and respects model capability.

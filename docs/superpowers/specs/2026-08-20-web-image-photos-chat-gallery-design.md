# Web Image Photos in Chat, Gallery & Sidebar — Design

Date: 2026-08-20
Branch: `feat/web-search-image-view` (add-on)

## 1. Goal

Photos the agent looks at via `view_image` (web images from `web_search`/`web_fetch`) should be:

1. **Visible in the chat message** — an inline, persistent thumbnail next to the `view_image` tool card (not only the transient bytes in the collapsible tool body).
2. **Visible in the gallery** — the left "Images" gallery modal.
3. **Visible in the right sidebar** — the "Images" section of the session documents rail.
4. **Campur** with generated images — web photos and `generate_image`/`edit_image` results live in one "Images" collection (label stays "Images", not "Generated images").
5. Each web photo carries a **source chip** (bottom-left overlay): globe icon; click opens the source URL in a new tab; hover reveals the URL (max 1 line, max width = half the image width).

Only photos the agent actually viewed via `view_image` are kept (user-confirmed). Errors (SSRF/404/non-raster) are never stored.

## 2. Strategy

Persist web photos into the **same** storage as generated images (`GeneratedImage` table + R2), tagged with `source = "web"` and the originating `sourceUrl`. Because the gallery modal, the right-rail "Images" section, and chat inline thumbnails all source their items from the `GeneratedImage` store/API, persisting there makes all three surfaces work with **no structural UI changes** — they simply start including the new rows.

> User-confirmed decisions
> - Source of photos: only images the agent looked at via `view_image` (vision bytes **and** non-vision description mode).
> - Scope: per session (like generated images today).
> - Gallery layout: mixed with generated images in one "Images" collection; label "Images".

## 3. Backend (`apps/api`)

### 3.1 Schema — `GeneratedImage`

Add two nullable fields (Prisma migration):

```prisma
model GeneratedImage {
  ...
  /// "generated" (image tools) or "web" (view_image of a public web URL).
  source     String  @default("generated")
  sourceUrl  String?
  ...
  @@index([sessionId, source])
}
```

### 3.2 `apps/api/src/modules/images/service.ts`

- `GeneratedImageRecord` gains `source: string` and `sourceUrl: string | null`.
- `saveGeneratedImage(input)` accepts optional `source?` (default `"generated"`) and `sourceUrl?` and persists them.
- Add a small helper `findSessionImageBySourceUrl({ userId, sessionId, sourceUrl })` returning the existing record or `null` (dedup helper; implemented via `prisma.generatedImage.findFirst({ where: { userId, sessionId, sourceUrl } })`).

### 3.3 `apps/api/src/modules/chat/vision-helper.ts`

- `ViewImageToolOptions` gains `projectId?: string | null`.
- New helper `imageDimensionsFromBuffer(buffer: Buffer, mediaType: string): { width: number; height: number }` — parse PNG IHDR / JPEG SOF0/SOF2 / GIF logical screen / WebP VP8× ; fall back to `{ width: 0, height: 0 }`.
- In `execute`, **only for the `url` path** (never for `imageId`, those are already stored) and **only when load succeeded** (both vision and description mode):
  1. Dedup: `store.findSessionImageBySourceUrl({ userId, sessionId, sourceUrl: url })` → reuse existing `imageId`; else
  2. Save: `store.saveGeneratedImage({ userId, sessionId, projectId, buffer: loaded.buffer, mediaType: loaded.mediaType, width, height, modelId: "web", prompt: question ?? url, source: "web", sourceUrl: url })` → `imageId`.
  3. Any save error is caught and logged; the run continues **without** an `imageId` (never fail the tool for a storage hiccup).
- Build a shared `imagesMeta = [{ imageId, modelId: "web", prompt: question ?? url, width, height, mediaType, index: 0, total: 1 }]` (+ `sourceUrl`).
- Output contract:
  - **vision mode** success: `[ { type: "text", text: JSON.stringify({ images: imagesMeta, sourceUrl }) }, { type: "image", data: base64, mediaType } ]` — the model still receives the bytes; the text part carries the persisted id for the UI.
  - **description mode** success: `JSON.stringify({ images: imagesMeta, description: result.text, sourceUrl })` — model reads `description`; UI reads `images`.
  - Error path unchanged (vision → `[{ type: "text", text: error }]`, description → error string), **no** `images`/`imageId`.

### 3.4 `apps/api/src/modules/chat/build-run-input.ts`

Pass `projectId` into both `createDefaultViewImageTool(...)` wiring points (non-vision description mode + vision web mode).

### 3.5 API responses

`GET /api/images` (session / project / user scopes) already maps `GeneratedImageRecord` → client meta; the added `source`/`sourceUrl` flow through automatically (update the mapping + `isGeneratedImageMeta` guard).

## 4. Frontend (`apps/platform`)

### 4.1 `src/lib/api.ts`

- `GeneratedImageMeta` gains `source: string` and `sourceUrl: string | null`.
- `isGeneratedImageMeta` guard + `parseGeneratedImages` updated.

### 4.2 `src/lib/chat/generated-images.ts`

- `GeneratedImageItem` gains `source: string` and `sourceUrl: string | null`.
- Add `isMessageImageToolName(name) = isImageToolName(name) || name === "view_image"`.
- `collectGeneratedImages` handles `view_image` parts:
  - vision mode: `output` is `ToolResultContent[]` → find the `type: "text"` item, `JSON.parse` it, read `.images[]`.
  - description mode: `output` is a JSON string → parse, read `.images[]`.
- `collectGeneratedImagesFromMessages`, `countRunningImageToolParts`, `groupImageToolRuns`, `mergeGeneratedImages` switch to `isMessageImageToolName` so `view_image` participates in inline runs, running skeletons, and dedup.

### 4.3 `src/components/chat/chat-message-row.tsx`

- Image-run grouping (`imageRuns`) uses `isMessageImageToolName` so a `view_image` tool part renders `GeneratedImageStrip`/`GeneratedImageThumbnail` inline (same visual language as generated images).

### 4.4 `src/components/tool-activity-panel.tsx`

- `ToolResultImages` (raw bytes grid) is **suppressed for `view_image`** to avoid duplicating the inline thumbnail (the collapsible still shows Request/Result text).

### 4.5 `src/components/images/generated-image-thumbnail.tsx` — source chip

Render **only when `image.source === "web"` and `image.sourceUrl`**:

- Position: absolute **bottom-left** inside the image: `absolute bottom-1 left-1`.
- Chip: small pill, `inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-1 text-white/85 backdrop-blur-sm`, globe icon (`Globe`, `size-3`, from lucide — same icon family used in "Web sources" rail).
- Click: `window.open(image.sourceUrl, "_blank", "noopener,noreferrer")`.
- Hover: reveal the URL in a small floating tooltip anchored above the chip:
  - max 1 line (`truncate`, `whitespace-nowrap`),
  - `max-width: min(50cqw, 12rem)` — half of the image width (use `container-type: inline-size` on the tile or a wrapper with a CSS variable for the 50% cap),
  - glass styling (`bg-black/70 text-white text-[10px] rounded-md px-1.5 py-0.5 backdrop-blur-sm`),
  - `aria-label` on the chip: `Open image source`.
- Native `title={image.sourceUrl}` as a fallback tooltip.
- Must not conflict with the existing bottom gradient prompt overlay (positioned `inset-x-0 bottom-0`) — chip sits above it (`bottom-1`), and the hover-prompt stays intact.
- Prompt hover overlay and chip both bottom-anchored; keep z-order: gradient < chip.

### 4.6 `src/components/images/image-gallery-modal.tsx`

- Modal title stays `"Images"`; description → `"Images you generated or viewed across chats"`.
- No structural change (mixed list comes from the store automatically).

### 4.7 `src/components/chat/session-documents-panel.tsx`

- Section title already `"Images"` — no rename needed.
- Items come from `fetchSessionImages` (now including `source=web` rows) → web thumbnails appear automatically; source chip renders via 4.5.

### 4.8 `src/routes/index.tsx`

- Ensure `refreshSessionImages()` runs after a run settles (`onStreamSettled` / `message_end`), so newly stored web photos appear in the rail + gallery without a reload. (Wire if not already present.)

## 5. Data flow

```
agent: view_image(url)
  → vision-helper: fetch (SSRF + raster check)
  → dedup by (sessionId, sourceUrl)
  → saveGeneratedImage(source="web", sourceUrl, r2Key) → imageId
  → tool output includes images[{imageId, sourceUrl, ...}]
UI:
  chat inline: view_image part → GeneratedImageThumbnail (persistent, click→preview, source chip)
  right rail "Images": fetchSessionImages → mixed grid (generated + web)
  gallery modal "Images": fetchUserImages/fetchProjectImages → mixed grid
```

## 6. Edge cases

- `view_image` error (SSRF / 404 / non-raster / timeout): nothing stored; output is the bounded error (no `images`).
- `view_image` with `imageId` (session/document image): never re-stored.
- Duplicate view of the same URL in a session → reuses the same `imageId` (one row per URL).
- Storage failure: run continues; chat still shows the transient bytes (vision) but no persistent thumbnail for that one.
- Web photos count toward the existing image storage; each web image ≤ 8 MiB (`VIEW_IMAGE_MAX_BYTES`).
- Source chip never renders for `source !== "web"` or missing `sourceUrl` (generated images unchanged).

## 7. Testing

### Unit
- `vision-helper.test.ts`:
  - vision `url` success → calls `saveGeneratedImage` with `source:"web"`, `sourceUrl`; output text JSON contains `images[0].imageId`.
  - description `url` success → output JSON `{ images, description, sourceUrl }`; store called.
  - dedup: same `url` twice → `saveGeneratedImage` called once; second returns same `imageId`.
  - non-raster (SVG) → error, store never called.
  - `imageId` path → store never called.
  - storage failure → tool still returns output (with imageId empty) without throwing.
- `image-gallery-flow` / service tests: `saveGeneratedImage` persists `source`/`sourceUrl`; `findSessionImageBySourceUrl` dedups.
- `generated-images.ts` (frontend, if covered by vitest): `collectGeneratedImages` parses `view_image` vision array (text JSON) and description JSON string.

### E2E (`apps/platform/e2e/web-search-image-view.e2e.ts`)
- After case 1 (vision) & case 4, assert `GET /api/images?sessionId=` includes at least one record with `source === "web"`.
- Assert the rail "Images" section renders a thumbnail for it (DOM: `img` with the source chip `aria-label="Open image source"`).

### Real-LLM hands-on
- Vision + non-vision run: photo appears inline in chat, in the rail "Images", and in the gallery modal; source chip shows and opens the source URL in a new tab; hover URL capped at half the image width, single line.

## 8. Out of scope

- Per-project web-photo collections beyond what `GeneratedImage` already provides.
- Filtering/sectioning photos separately from generated images (user chose mixed).
- Thumbnails for `web_search`/`web_fetch` `images[]` that the agent did not `view_image`.

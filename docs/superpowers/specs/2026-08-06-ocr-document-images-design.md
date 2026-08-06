# OCR Document Images — Design Spec

Date: 2026-08-06
Branch: `feat/ocr-document-images`

## Problem

Documents ingested via Mistral OCR may contain images (charts, photos, diagrams).
Today the pipeline (`runDocumentOcr` → worker → `DocumentPage` → Qdrant chunks) keeps
only OCR text/markdown. `page.images` from the Mistral OCR response is discarded, so:

- The chat agent cannot *see* document images (no vision path).
- The UI cannot display them (no storage, no serving, no renderer).

## Goals

1. Persist OCR-extracted images per document page (binary in R2, metadata in Postgres).
2. Let the agent fetch page images via a new tool `get_document_page_images` that
   returns text + image content parts, so the completion model sees the pixels.
3. Let the agent embed images inline in the middle of its streamed answer via
   markdown `![](/api/documents/.../images/...)`, rendered with a loading indicator.
4. Show fetched images in the tool activity card.
5. Show page images in the document preview pane, correctly associated with their page.
6. A reusable, accessible image preview (lightbox) with zoom in/out and subtle animation.
7. Work identically for global chats and project chats with zero duplication
   (shared tooling + shared UI components; session/project scoping already lives in
   `resolveSessionDocumentIds` / `resolveActiveDocuments`).

## Facts established during research

- Mistral OCR (`@mistralai/mistralai@2.5.0` via `@anvia/mistral@0.3.7`) returns
  `page.images: OCRImageObject[] = { id, topLeftX/Y, bottomRightX/Y, imageBase64?, imageAnnotation? }`.
  **There is no CDN URL**; images arrive as base64 data URLs only when
  `includeImageBase64: true`. Data URL format: `data:image/jpeg;base64,...`.
- `@anvia/core@0.16.0` `ToolResultContent` supports `{ type: "image"; data; mediaType }`;
  tool output may be `string | ToolResultContent[]`.
- `@anvia/openai@0.4.0` (responses API) maps tool-result image parts to
  `input_image` with `data:${mediaType};base64,${data}` — the tool must return
  **raw base64** (no prefix) + `mediaType`.
- Agent tool messages **are persisted to memory** (`newMessages.push(toolMessage)` →
  `memory.store.append`). Raw base64 in tool results would bloat Postgres and be
  replayed to the model every turn → we sanitize on persist.
- UI receives tool output via `tool_result` event `structuredResult` — images can be
  rendered from `part.output`.
- `@anvia/core` throws on images in assistant history — images must only appear in
  user/tool content (our design only ever puts them in tool results, which are not
  replayed once sanitized).
- Chat markdown already styles `img` (`CHAT_MARKDOWN_CLASS`); react-markdown
  `defaultUrlTransform` blocks `data:` URLs → internal images must use HTTP URLs
  (our serving endpoint) or blob URLs (fetch + credentials).
- API CORS allows credentials (`PLATFORM_ORIGIN` + `credentials: true`).
- Chat UI is 100% shared between global and project chats (`ChatSession`).

## Design

### 1. OCR layer (`packages/agent`)

`src/ocr/run-document-ocr.ts`:

- Request `includeImageBase64: true` (keep `tableFormat: "markdown"`).
- Parse each page image: split data URL prefix → `mediaType`; keep raw base64.
- New exported types (in `src/document/types.ts`):

```ts
export interface OcrPageImage {
  id: string;
  mediaType: string;
  base64: string;            // raw base64, no data: prefix
  topLeftX: number | null;
  topLeftY: number | null;
  bottomRightX: number | null;
  bottomRightY: number | null;
  annotation?: string | null;
}

export interface DocumentPageImage {  // persisted shape (DB + tool output metadata)
  id: string;
  r2Key: string;
  mediaType: string;
  topLeftX: number | null;
  topLeftY: number | null;
  bottomRightX: number | null;
  bottomRightY: number | null;
  annotation?: string | null;
}
```

- `runDocumentOcr` returns `pages: Array<{ index; markdown; images: OcrPageImage[] }>`.
  Images are only exposed when the request asked for base64; otherwise empty array.

### 2. DB (`apps/api`)

`DocumentPage` gains a column:

```prisma
images Json?
```

Holds `DocumentPageImage[]` (metadata only — never base64). Migration:
`apps/api/prisma/migrations/<ts>_add_document_page_images/migration.sql`
(`ALTER TABLE "DocumentPage" ADD COLUMN "images" JSONB;`).

### 3. Worker (`apps/api/src/worker.ts`)

Per page, for each `OcrPageImage`:

- Build R2 key:
  `users/{userId}/sessions/{sessionId}/{documentId}/pages/{pageIndex}/images/{imageId}.{ext}`
  where `ext` derives from `mediaType`.
- `putObject(r2Key, Buffer.from(base64, "base64"), mediaType)`.
- Collect `DocumentPageImage`; failures are logged and skipped (ingest must not fail
  because one image failed).
- Store `images` JSON on the `DocumentPage` row inside the existing transaction.

### 4. Image serving (`apps/api/src/modules/documents`)

`GET /api/documents/:documentId/pages/:pageIndex/images/:imageId`:

- Authz: `document.userId === user.id && status === "ready"` (same pattern as
  `getDocumentPreview`); 404 otherwise.
- Load page → find image metadata by `imageId` → `getObjectBuffer(r2Key)` →
  `c.body(buffer, { headers: { "content-type": mediaType, "cache-control": "private, max-age=3600" } })`.
- No directory traversal risk: the R2 key comes from the DB, never from the request.

`getDocumentPreview` gains `images` (metadata) per page.

`deleteUserDocument`: best-effort delete of each page image R2 object (keys from DB).

### 5. Agent tool (`packages/agent/src/tools/documents.ts`)

New tool `get_document_page_images`:

- Input `{ documentId: string; pageIndex: number; limit?: number (1..8, default 5) }`.
- Scope via existing `resolveSessionDocumentIds` (project-aware → works in both
  global and project chats, no duplication).
- Load `DocumentPage.images`; fetch each selected image from R2
  (injected `fetchPageImage(r2Key) => Uint8Array` service so the tool stays testable).
- Return `ToolResultContent[]`:
  - `{ type: "text" }` — JSON summary incl. markdown URLs:
    `![{id}](/api/documents/{documentId}/pages/{pageIndex}/images/{id})`,
    media types, bbox hints, annotation when present.
  - `{ type: "image", data: base64, mediaType }` per image.
- Tool description explains: use when the answer depends on visual content; images
  may be embedded inline at the most relevant position in the answer.

`DocumentToolDeps` gains `fetchPageImage` (implemented in `apps/api` with R2).

### 6. Memory sanitizer (`apps/api/src/modules/chat`)

`createSanitizedMemoryStore(prisma)` wraps `createPrismaMemoryStore(prisma)`:

- `append` proxy: strip `{ type: "image" }` content from `tool` messages
  (keep `text` parts and message shape intact) before delegating.
- `load`/`clear`/`recordError` delegate unchanged.
- Router uses the wrapper instead of the raw store.

### 7. Agent instructions

- `build-document-catalog.ts` (or router additionalInstructions): when images exist
  on a page, mention it in the catalog line.
- Router: new instruction block — use `get_document_page_images` when visuals matter;
  embed `![](...)` inline at the most relevant point (never as a fixed header/footer);
  only embed genuinely relevant images.

### 8. Platform UI

Shared components → works in both chat modes automatically.

**a. Tool activity** (`components/tool-activity-panel.tsx`, `lib/chat`/`tool-io-format.ts`):

- Label map entry: `get_document_page_images: "Inspecting page images"`.
- `ToolSectionView` (or panel) renders image parts from tool output as a thumbnail
  grid (`grid grid-cols-3 gap-2`, `rounded-lg`, `border border-white/[0.06]`),
  clickable → opens image preview.
- Formatter for the text summary (existing `formatToolOutput` style).

**b. Inline chat images** (`components/math-markdown.tsx`):

- Custom `img` component:
  - Internal URL (`/api/documents/...` or `API_BASE/api/documents/...`) →
    `useDocumentImage()` hook: fetch with `credentials: "include"`, decode to blob
    URL; render skeleton shimmer + "Loading image…" while pending; error state with
    retry on failure.
  - External URLs render as normal `<img>`.
  - Wrapped in an accessible button → opens the image preview.
- Streaming indicator: skeleton block in the exact markdown position while loading,
  no layout jump.

**c. Document preview pane** (`components/documents/document-preview-pane.tsx`):

- `DocumentPreviewPage` gains `images`; render image thumbnails below the page
  markdown (they belong to that page — correct placement), clickable → preview.

**d. Image preview (lightbox)** — new `components/images/image-preview.tsx`:

- `ImagePreviewProvider` (mounted once in the route root) + `useImagePreview()`
  → `open({ src, alt })`.
- Native `<dialog>` + `showModal()` + portal (pattern of
  `document-preview-modal.tsx`), remount keyed.
- Behavior:
  - Zoom in/out buttons (−, +, reset) and wheel zoom centered on cursor.
  - Pan by drag when scaled > 1 (pointer events; `touch-action: none`).
  - Double-click toggles zoom.
  - Keyboard: `+`/`-`/`0` zoom, `Escape` close, focus trapped in dialog,
    focus restored on close.
- Accessibility: `role="dialog"`, `aria-modal="true"`, `aria-label` with alt text,
  labelled buttons, `alt` shown in the footer, `prefers-reduced-motion` respected
  (no transform animation under reduced motion).
- Subtle animation: fade + slight scale on open (`ease-out-premium`,
  `duration-med`), transform transitions on zoom — all gated behind
  `@media (prefers-reduced-motion: no-preference)`.
- Styling: `glass` dialog backdrop (`bg-canvas/80 backdrop-blur`), toolbar
  `border-t border-white/[0.06]`, buttons follow `glass-interactive` hover.

### 9. Security & hygiene

- Images are only reachable through authenticated endpoints; R2 keys live in DB,
  never derived from request input.
- Tool results sanitized on memory persist (no base64 in Postgres).
- Base64 travels only: Mistral → worker (R2), R2 → model (tool result), R2 → browser
  (authenticated endpoint). Never in chat history storage.
- Ingest skips failed image uploads without failing the document.
- `imageLimit`/`imageMinSize`: Mistral defaults (8/page, min 100px) — bounded payloads.

## Out of scope

- Embedding images as vectors (text-only retrieval stays).
- Image caption generation / OCR `image_annotation` summarization.
- Uploading user chat attachments as images (still stripped by
  `stripUserAttachments`).

## Verification

1. `npx tsc -p packages/agent/tsconfig.json --noEmit`
2. `pnpm --filter api build` (tsc)
3. `npx tsc -p apps/platform/tsconfig.json --noEmit` and `pnpm --filter platform build`
4. Prisma migrate + manual smoke: ingest image-rich PDF, check R2 keys + DB rows,
   chat in global session and project session, inline image renders mid-stream,
   tool card thumbnails, lightbox zoom/a11y.
5. Manual gateway smoke: confirm `input_image` accepted by the completion endpoint
   (OpenAI-compatible gateway capability — outside our control).

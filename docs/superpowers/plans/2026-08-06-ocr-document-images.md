# OCR Document Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist OCR-extracted document images (R2 + Postgres), let the agent see and inline them in chat (tool `get_document_page_images`), show them in tool cards and the preview pane, and add an accessible zoomable image preview — working in both global and project chats.

**Architecture:** Mistral OCR (`includeImageBase64: true`) → worker decodes data URLs, uploads binaries to R2, stores metadata JSON on `DocumentPage.images`. A new agent tool returns `ToolResultContent[]` (text summary + base64 image parts) to the model/UI; memory sanitizer strips image parts on persist. New authenticated serving endpoint `/api/documents/:id/pages/:pageIndex/images/:imageId`. Frontend: shared components (`DocumentImage`, `ImagePreviewProvider`, tool-card thumbnails, preview-pane images) — one code path for both chat modes.

**Tech Stack:** TypeScript monorepo (pnpm), Hono, Prisma 7 (Postgres), BullMQ, @anvia/core 0.16, @anvia/mistral 0.3.7, @anvia/openai 0.4.0 (responses), Qdrant, React 19 + @anvia/react-ui 0.6.2, Tailwind v4.

## Global Constraints

- No test framework exists in the repo — verification is `tsc --noEmit` + `pnpm build` + manual smoke. Keep functions pure/injected so tests can be added later.
- `packages/agent`: `module: nodenext`, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` — follow exactly.
- `apps/platform` tsconfig: `strict`, `noUnusedLocals`, `noUnusedParameters` — no dead code.
- `apps/api`: `strict`, `verbatimModuleSyntax`, `jsxImportSource: hono/jsx`, Prisma generated client at `apps/api/src/generated/prisma` (regenerate via `pnpm --filter api db:generate` after schema edits).
- Tool outputs with images MUST NOT be persisted to memory (sanitizer wrapper).
- Image base64 in tool result content must be **raw base64** (`data`), `mediaType` separate — `@anvia/openai` prepends the `data:` prefix itself.
- R2 keys come from DB rows only, never from request input.
- Every new UI piece must reuse existing design tokens (`bg-canvas`, `text-text-muted`, `border-hairline`, `bg-accent`, `skeleton-shimmer`, `glass-*`, `animate-scale-in`, `ease-[cubic-bezier(0.16,1,0.3,1)]`) and honor `prefers-reduced-motion` (`motion-reduce:` variants).
- Do NOT change tool behavior for sessions without active documents; do NOT break the citation fence protocol.

---

### Task 1: OCR image extraction types + `includeImageBase64`

**Files:**
- Modify: `packages/agent/src/ocr/run-document-ocr.ts`
- Modify: `packages/agent/src/document/types.ts` (add `DocumentPageImage` + `normalizePageImages`)

**Interfaces:**
- Consumes: `ocrModel.ocr(...)` from `packages/agent/src/providers/mistral.ts` (already exists).
- Produces: `OcrPageImage` (exported from `run-document-ocr.ts`), `DocumentPageImage` + `normalizePageImages(value: unknown): DocumentPageImage[]` (exported from `document/types.ts`), extended `runDocumentOcr` return: `pages: Array<{ index: number; markdown: string; images: OcrPageImage[] }>`.

- [ ] **Step 1: Add shared persisted-image types to `packages/agent/src/document/types.ts`**

Append:

```ts
export interface DocumentPageImage {
  id: string;
  r2Key: string;
  mediaType: string;
  topLeftX: number | null;
  topLeftY: number | null;
  bottomRightX: number | null;
  bottomRightY: number | null;
  annotation?: string | null;
}

export function normalizePageImages(value: unknown): DocumentPageImage[] {
  if (!Array.isArray(value)) return [];
  const images: DocumentPageImage[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const r2Key = typeof record.r2Key === "string" ? record.r2Key : null;
    const mediaType = typeof record.mediaType === "string" ? record.mediaType : null;
    if (id === null || r2Key === null || mediaType === null) continue;
    const numberOrNull = (raw: unknown): number | null =>
      typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    const annotation =
      typeof record.annotation === "string" ? record.annotation : null;
    images.push({
      id,
      r2Key,
      mediaType,
      topLeftX: numberOrNull(record.topLeftX),
      topLeftY: numberOrNull(record.topLeftY),
      bottomRightX: numberOrNull(record.bottomRightX),
      bottomRightY: numberOrNull(record.bottomRightY),
      ...(annotation === null ? {} : { annotation }),
    });
  }
  return images;
}
```

- [ ] **Step 2: Rewrite `packages/agent/src/ocr/run-document-ocr.ts`**

```ts
import { ocrModel } from "../providers/mistral.js";

export interface OcrPageImage {
  id: string;
  mediaType: string;
  /** Raw base64 without the `data:<type>;base64,` prefix. */
  base64: string;
  topLeftX: number | null;
  topLeftY: number | null;
  bottomRightX: number | null;
  bottomRightY: number | null;
  annotation?: string | null;
}

export interface OcrPage {
  index: number;
  markdown: string;
  images: OcrPageImage[];
}

/** `data:image/png;base64,AAAA...` → `{ mediaType: "image/png", base64: "AAAA..." }` */
function splitImageDataUrl(dataUrl: string): { mediaType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return null;
  const mediaType = match[1] ?? "";
  const base64 = match[2] ?? "";
  if (mediaType.length === 0 || base64.length === 0) return null;
  return { mediaType, base64 };
}

function pickNumber(
  record: Record<string, unknown>,
  camel: string,
  snake: string,
): number | null {
  const raw = record[camel] ?? record[snake];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** Mistral's raw `images` array: tolerate both snake_case and camelCase keys. */
function toOcrPageImages(raw: unknown): OcrPageImage[] {
  if (!Array.isArray(raw)) return [];
  const images: OcrPageImage[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : null;
    const imageBase64 = record.imageBase64 ?? record.image_base64;
    if (id === null || typeof imageBase64 !== "string") continue;
    const split = splitImageDataUrl(imageBase64);
    if (!split) continue;
    const annotation =
      typeof record.imageAnnotation === "string"
        ? record.imageAnnotation
        : typeof record.image_annotation === "string"
          ? record.image_annotation
          : null;
    images.push({
      id,
      mediaType: split.mediaType,
      base64: split.base64,
      topLeftX: pickNumber(record, "topLeftX", "top_left_x"),
      topLeftY: pickNumber(record, "topLeftY", "top_left_y"),
      bottomRightX: pickNumber(record, "bottomRightX", "bottom_right_x"),
      bottomRightY: pickNumber(record, "bottomRightY", "bottom_right_y"),
      ...(annotation === null ? {} : { annotation }),
    });
  }
  return images;
}

export async function runDocumentOcr(input: {
  filename: string;
  data: Uint8Array;
}) {
  const result = await ocrModel.ocr({
    source: {
      type: "bytes",
      data: input.data,
      filename: input.filename,
    },
    tableFormat: "markdown",
    includeImageBase64: true,
  });

  return {
    text: result.text,
    markdown: result.markdown,
    pages: result.pages.map((page) => ({
      index: page.index,
      markdown: page.markdown,
      images: toOcrPageImages(page.images),
    })),
    pageCount: result.pages.length,
  };
}

export type { OcrPage };
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc -p packages/agent/tsconfig.json --noEmit`
Expected: no errors (note: `result.pages[].images` is `unknown[]` on the SDK type — `toOcrPageImages(page.images)` accepts `unknown`, so no cast needed).

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/ocr/run-document-ocr.ts packages/agent/src/document/types.ts
git commit -m "feat(agent): extract OCR page images with includeImageBase64"
```

---

### Task 2: Prisma schema + migration for `DocumentPage.images`

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (model `DocumentPage`, lines ~249-260)
- Create: `apps/api/prisma/migrations/20260806000000_add_document_page_images/migration.sql`

**Interfaces:**
- Produces: `DocumentPage.images: Json?` column; regenerated Prisma client so `documentPage.findMany/create` accept `images`.

- [ ] **Step 1: Edit schema**

```prisma
model DocumentPage {
  id          String   @id @default(cuid())
  documentId  String
  document    Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
  pageIndex   Int
  summary     String   @db.Text
  rawMarkdown String   @db.Text
  /// OCR-extracted images for this page: DocumentPageImage[] metadata (no base64).
  images      Json?
  createdAt   DateTime @default(now())

  @@unique([documentId, pageIndex])
  @@index([documentId, pageIndex])
}
```

- [ ] **Step 2: Create migration file**

`apps/api/prisma/migrations/20260806000000_add_document_page_images/migration.sql`:

```sql
-- AlterTable
ALTER TABLE "DocumentPage" ADD COLUMN "images" JSONB;
```

- [ ] **Step 3: Regenerate the Prisma client**

Run: `pnpm --filter api db:generate`
Expected: client regenerated into `apps/api/src/generated/prisma`.

- [ ] **Step 4: Verify API typecheck**

Run: `pnpm --filter api build`
Expected: builds clean (no code uses `images` yet).

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(api): add DocumentPage.images JSON column"
```

---

### Task 3: Worker — upload images to R2 and persist metadata

**Files:**
- Modify: `apps/api/src/lib/r2.ts` (add `buildPageImageR2Key`)
- Modify: `apps/api/src/worker.ts`

**Interfaces:**
- Consumes: `runDocumentOcr` (Task 1: `OcrPage.images`), `normalizePageImages`/`DocumentPageImage` (Task 1), `putObject` (existing).
- Produces: `buildPageImageR2Key(input: { userId; sessionId; documentId; pageIndex; imageId; mediaType }): string` — key pattern `users/{userId}/sessions/{sessionId}/{documentId}/pages/{pageIndex}/images/{imageId}.{ext}`.

- [ ] **Step 1: Add R2 key builder + extension mapping to `apps/api/src/lib/r2.ts`**

Append at the end:

```ts
export function buildPageImageR2Key(input: {
  userId: string;
  sessionId: string;
  documentId: string;
  pageIndex: number;
  imageId: string;
  mediaType: string;
}): string {
  const ext = mediaTypeToExtension(input.mediaType);
  return `users/${input.userId}/sessions/${input.sessionId}/${input.documentId}/pages/${input.pageIndex}/images/${input.imageId}.${ext}`;
}

function mediaTypeToExtension(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/svg+xml":
      return "svg";
    default:
      return "img";
  }
}
```

- [ ] **Step 2: Upload images in the worker**

In `apps/api/src/worker.ts` `processDocumentIngest`, before the transaction (after `const ocr = await runDocumentOcr(...)`), build per-page image metadata. Add imports: `normalizePageImages` no longer needed here — we construct `DocumentPageImage[]` directly from `OcrPageImage`. Import `putObject` and `buildPageImageR2Key` from `./lib/r2.js`, and `type DocumentPageImage` from `@assingment/agent`.

```ts
const pageImages = new Map<number, DocumentPageImage[]>();

for (const page of ocr.pages) {
  const stored: DocumentPageImage[] = [];
  await Promise.all(
    page.images.map(async (image) => {
      try {
        const r2Key = buildPageImageR2Key({
          userId,
          sessionId,
          documentId,
          pageIndex: page.index,
          imageId: image.id,
          mediaType: image.mediaType,
        });
        await putObject(r2Key, Buffer.from(image.base64, "base64"), image.mediaType);
        stored.push({
          id: image.id,
          r2Key,
          mediaType: image.mediaType,
          topLeftX: image.topLeftX,
          topLeftY: image.topLeftY,
          bottomRightX: image.bottomRightX,
          bottomRightY: image.bottomRightY,
          ...(image.annotation === undefined ? {} : { annotation: image.annotation }),
        });
      } catch (error) {
        console.error(
          `[worker] page image upload failed ${documentId} page ${page.index} image ${image.id}`,
          error,
        );
      }
    }),
  );
  pageImages.set(page.index, stored);
}
```

Note: `Promise.all` with per-image try/catch never rejects; `stored.push` is safe (map callbacks run on the same microtask queue after awaits — array mutations are sequential enough for this bounded loop; for full safety use `Promise.allSettled`).

- [ ] **Step 3: Persist `images` in the page transaction**

Inside the existing `for (const page of ocr.pages)` transaction loop, add `images` to `tx.documentPage.create`:

```ts
await tx.documentPage.create({
  data: {
    documentId,
    pageIndex: page.index,
    summary,
    rawMarkdown: page.markdown,
    images: pageImages.get(page.index) ?? [],
  },
});
```

- [ ] **Step 4: Verify typecheck**

Run: `pnpm --filter api build`
Expected: clean (Prisma Json accepts `DocumentPageImage[]`).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/r2.ts apps/api/src/worker.ts
git commit -m "feat(worker): persist OCR page images to R2 with metadata"
```

---

### Task 4: Image serving endpoint + preview images + delete cleanup

**Files:**
- Modify: `apps/api/src/modules/documents/service.ts` (`getPageImage`, `getDocumentPreview` pages select, `deleteUserDocument`)
- Modify: `apps/api/src/modules/documents/router.ts` (new route)

**Interfaces:**
- Consumes: `getObjectBuffer` (existing), `normalizePageImages` from `@assingment/agent`, `deleteObject` (existing).
- Produces: `getPageImage(input: { userId; documentId; pageIndex; imageId }): Promise<{ data: Uint8Array; mediaType: string } | null>`; preview pages now include `images: Array<{ id: string; mediaType: string }>` (metadata only — no `r2Key`).

- [ ] **Step 1: Add `getPageImage` to `apps/api/src/modules/documents/service.ts`**

```ts
export async function getPageImage(input: {
  userId: string;
  documentId: string;
  pageIndex: number;
  imageId: string;
}): Promise<{ data: Uint8Array; mediaType: string } | null> {
  const document = await prisma.document.findFirst({
    where: { id: input.documentId, userId: input.userId, status: "ready" },
    select: { id: true },
  });
  if (!document) return null;

  const page = await prisma.documentPage.findFirst({
    where: { documentId: document.id, pageIndex: input.pageIndex },
    select: { images: true },
  });
  if (!page) return null;

  const image = normalizePageImages(page.images).find(
    (entry) => entry.id === input.imageId,
  );
  if (!image) return null;

  try {
    const data = await getObjectBuffer(image.r2Key);
    return { data, mediaType: image.mediaType };
  } catch (error) {
    console.error("[documents] page image fetch failed", {
      documentId: input.documentId,
      pageIndex: input.pageIndex,
      imageId: input.imageId,
      error,
    });
    return null;
  }
}
```

- [ ] **Step 2: Include `images` in `getDocumentPreview`**

Change the `documentPage.findMany` select (add `images: true`) and normalize before returning:

```ts
select: {
  pageIndex: true,
  summary: true,
  rawMarkdown: true,
  images: true,
},
```

After the query, map pages — strip internal `r2Key` from the response (clients never need storage keys):

```ts
const pages = rawPages.map((page) => ({
  pageIndex: page.pageIndex,
  summary: page.summary,
  rawMarkdown: page.rawMarkdown,
  images: normalizePageImages(page.images).map(({ id, mediaType }) => ({
    id,
    mediaType,
  })),
}));
```

- [ ] **Step 3: Delete page images on document delete**

In `deleteUserDocument`, before `prisma.document.delete`, collect keys; after commit, best-effort delete each:

```ts
const pages = await prisma.documentPage.findMany({
  where: { documentId: document.id },
  select: { images: true },
});
const imageKeys = pages.flatMap((page) =>
  normalizePageImages(page.images).map((image) => image.r2Key),
);
```

After the existing `document.r2Key` cleanup block, add:

```ts
for (const key of imageKeys) {
  try {
    await deleteObject(key);
  } catch (error) {
    console.error("[documents] page image R2 delete failed", { key, error });
  }
}
```

- [ ] **Step 4: Add the serving route in `apps/api/src/modules/documents/router.ts`**

Place it next to the preview route (before `/:id`):

```ts
.get("/:id/pages/:pageIndex/images/:imageId", async (c) => {
  const user = c.get("user");
  const pageIndex = Number(c.req.param("pageIndex"));
  const image = await getPageImage({
    userId: user.id,
    documentId: c.req.param("id"),
    pageIndex,
    imageId: c.req.param("imageId"),
  });
  if (!image) {
    return c.json({ error: "Image not found" }, 404);
  }
  return c.body(image.data, 200, {
    "content-type": image.mediaType,
    "cache-control": "private, max-age=3600",
  });
})
```

Guard: if `!Number.isInteger(pageIndex) || pageIndex < 0` return 404.

- [ ] **Step 5: Verify typecheck**

Run: `pnpm --filter api build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/documents/service.ts apps/api/src/modules/documents/router.ts
git commit -m "feat(api): serve document page images with ownership check"
```

---

### Task 5: Agent tool `get_document_page_images`

**Files:**
- Modify: `packages/agent/src/tools/documents.ts`
- Modify: `packages/agent/src/index.ts` (export new tool)

**Interfaces:**
- Consumes: `resolveSessionDocumentIds` (existing, project-aware), `normalizePageImages` (Task 1), `ToolResultContent` type from `@anvia/core`.
- Produces: `createGetDocumentPageImagesTool(deps: { userId; sessionId; projectId?; prisma: PageImagesPrisma & SessionDocumentIdsPrisma; fetchPageImage: (r2Key: string) => Promise<Uint8Array>; maxImages?: number }): AnyTool`; `PageImagesPrisma` and `FetchPageImage` types exported; `DocumentToolsDeps` gains `fetchPageImage` and `createDocumentTools` forwards it.

- [ ] **Step 1: Add tool to `packages/agent/src/tools/documents.ts`**

Append imports at top: `import { ToolResultContent } from "@anvia/core";` (type-only) and `import { normalizePageImages } from "../document/types.js";`. Add types + tool:

```ts
export interface PageImagesPrisma {
  documentPage: {
    findFirst(args: {
      where: { documentId: string; pageIndex: number };
      select: { id: true; images: true };
    }): Promise<{ id: string; images: unknown } | null>;
  };
}

export interface FetchPageImage {
  (r2Key: string): Promise<Uint8Array>;
}

export function createGetDocumentPageImagesTool(deps: {
  userId: string;
  sessionId: string;
  projectId?: string | null;
  prisma: PageImagesPrisma & SessionDocumentIdsPrisma;
  fetchPageImage: FetchPageImage;
  maxImages?: number;
}) {
  return createTool({
    name: "get_document_page_images",
    description:
      "Fetch images extracted from a document page (charts, photos, diagrams). Use when the answer depends on visual content in the document. Returns the images together with markdown references you can embed inline in your answer at the most relevant position.",
    input: z.object({
      documentId: z.string().min(1).describe("Document id from the session catalog"),
      pageIndex: z.number().int().min(0).describe("0-based page index"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(5)
        .describe("Max images to return"),
    }),
    execute: async ({ documentId, pageIndex, limit }) => {
      const sessionDocIds = await resolveSessionDocumentIds(
        deps.prisma,
        deps.userId,
        deps.sessionId,
        deps.projectId,
      );
      if (!sessionDocIds.includes(documentId)) {
        return [
          {
            type: "text",
            text: JSON.stringify({
              found: false,
              reason: "Document not found in current session",
            }),
          },
        ] satisfies ToolResultContent[];
      }

      const page = await deps.prisma.documentPage.findFirst({
        where: { documentId, pageIndex },
        select: { id: true, images: true },
      });
      const images = normalizePageImages(page?.images).slice(0, limit);

      if (images.length === 0) {
        return [
          {
            type: "text",
            text: JSON.stringify({ found: true, pageIndex, imageCount: 0 }),
          },
        ] satisfies ToolResultContent[];
      }

      const content: ToolResultContent[] = [
        {
          type: "text",
          text: JSON.stringify({
            found: true,
            pageIndex,
            images: images.map((image) => ({
              id: image.id,
              mediaType: image.mediaType,
              markdown: `![${image.id}](/api/documents/${documentId}/pages/${pageIndex}/images/${image.id})`,
              ...(image.annotation === null || image.annotation === undefined
                ? {}
                : { annotation: image.annotation }),
            })),
          }),
        },
      ];

      const toFetch = images.slice(0, deps.maxImages ?? 5);
      const results = await Promise.allSettled(
        toFetch.map(async (image) => ({
          image,
          data: await deps.fetchPageImage(image.r2Key),
        })),
      );
      for (const result of results) {
        if (result.status === "rejected") continue;
        content.push({
          type: "image",
          data: Buffer.from(result.value.data).toString("base64"),
          mediaType: result.value.image.mediaType,
        });
      }

      return content;
    },
  });
}
```

- [ ] **Step 2: Wire into `DocumentToolsDeps` + `createDocumentTools`**

```ts
export interface DocumentToolsDeps {
  userId: string;
  sessionId: string;
  projectId?: string | null;
  prisma: FindDocumentsPrisma &
    NextPagePrisma &
    SessionDocumentIdsPrisma &
    PageImagesPrisma;
  searchService: ChunkSearchService;
  fetchPageImage: FetchPageImage;
}
```

And in `createDocumentTools` return array add:

```ts
createGetDocumentPageImagesTool(deps),
```

- [ ] **Step 3: Export from `packages/agent/src/index.ts`**

Add line: `export * from "./tools/documents.js";` already exists — no change needed since the new symbol is exported from that module. Verify `ToolResultContent` is exported from `@anvia/core` (it is: `q as ToolResultContent`).

- [ ] **Step 4: Verify typecheck**

Run: `npx tsc -p packages/agent/tsconfig.json --noEmit`
Expected: clean (Buffer is typed via `@types/node`).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools/documents.ts
git commit -m "feat(agent): add get_document_page_images tool returning text + images"
```

---

### Task 6: Memory sanitizer + chat router wiring + agent instructions

**Files:**
- Create: `apps/api/src/modules/chat/memory-sanitizer.ts`
- Modify: `apps/api/src/modules/chat/router.ts`
- Create: `packages/agent/src/prompts/document-image-instructions.ts`
- Modify: `packages/agent/src/prompts/build-document-catalog.ts`
- Modify: `packages/agent/src/index.ts` (export new prompt)

**Interfaces:**
- Consumes: `createPrismaMemoryStore` from `@anvia/memory-prisma`, `MemoryStore` type from `@anvia/core`.
- Produces: `createSanitizedMemoryStore(prisma: PrismaClient): MemoryStore`; `DOCUMENT_IMAGE_INSTRUCTION: string`; updated catalog instruction.

- [ ] **Step 1: Create `apps/api/src/modules/chat/memory-sanitizer.ts`**

```ts
import type { MemoryStore } from "@anvia/core";
import { createPrismaMemoryStore } from "@anvia/memory-prisma";
import type { PrismaClient } from "../generated/prisma/client.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip image content parts from tool messages before persistence so base64
 * never lands in the memory table (it is replayed to the model otherwise).
 * Text parts and message shape are preserved; callId pairing stays intact.
 */
function sanitizeMessages(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (!isRecord(message) || message.role !== "tool") return message;
    if (!Array.isArray(message.content)) return message;

    const content = message.content.filter(
      (part) => !(isRecord(part) && part.type === "image"),
    );
    if (content.length === 0) {
      content.push({ type: "text", text: "" });
    }
    return { ...message, content };
  });
}

export function createSanitizedMemoryStore(prisma: PrismaClient): MemoryStore {
  const inner = createPrismaMemoryStore(prisma);
  return {
    ...inner,
    append: async (input) => {
      await inner.append({
        ...input,
        messages: sanitizeMessages(input.messages),
      });
    },
  } as MemoryStore;
}
```

Note: if `MemoryStore.append`'s `messages` type is not `unknown[]`, widen with a minimal local interface cast in `sanitizeMessages` calls. Verify the shape of `MemoryStore` in `@anvia/core` (`dist/chunk-PJCJ45RJ.js` shows `append({ context, runId, turn, messages })`).

- [ ] **Step 2: Use the sanitizer in `apps/api/src/modules/chat/router.ts`**

Replace `const prismaMemory = createPrismaMemoryStore(prisma);` (line ~332) with:

```ts
const prismaMemory = createSanitizedMemoryStore(prisma);
```

Add import. Also pass `fetchPageImage` into `createDocumentTools` (line ~344):

```ts
const documentTools = hasActiveDocuments
  ? createDocumentTools({
      sessionId,
      userId: user.id,
      projectId,
      prisma,
      searchService: createChunkSearchService(),
      fetchPageImage: (r2Key) => getObjectBuffer(r2Key),
    })
  : [];
```

Add `import { getObjectBuffer } from "../../lib/r2.js";` (adjust relative path: router.ts lives in `apps/api/src/modules/chat/` → `../../lib/r2.js`).

And add the image instruction to `additionalInstructions` when documents exist:

```ts
...(hasActiveDocuments ? [DOCUMENT_IMAGE_INSTRUCTION] : []),
```

- [ ] **Step 3: Create `packages/agent/src/prompts/document-image-instructions.ts`**

```ts
export const DOCUMENT_IMAGE_INSTRUCTION = `Document images:
- Document pages may contain images extracted by OCR (charts, photos, diagrams, tables as images).
- When the answer depends on visual content, call get_document_page_images with the document id and page index, then examine the returned images before answering.
- If an image genuinely supports your answer, embed it inline at the most relevant position using its markdown reference, e.g. ![img](/api/documents/<documentId>/pages/<pageIndex>/images/<imageId>).
- Place images where they support the surrounding text — never as a fixed header or footer of your reply, and never repeat the same image.
- Only embed images that directly support the answer; keep the total number small.`;
```

- [ ] **Step 4: Update `build-document-catalog.ts`**

In the with-documents instruction list, change item 4 and add 5 (renumber):

```
4. If the answer depends on visual content (charts, photos, diagrams), call get_document_page_images for the relevant page.
5. If a page seems incomplete, call get_document_next_page.
6. Ground claims with [[cite:N]] markers and a trailing ```citations JSON block (see citation instructions). Never invent ids or pages.
7. Only use ids from this catalog — ignore documents that are not listed (e.g. unlinked from the session).
```

- [ ] **Step 5: Export from `packages/agent/src/index.ts`**

Add: `export * from "./prompts/document-image-instructions.js";`

- [ ] **Step 6: Verify typecheck both packages**

Run: `npx tsc -p packages/agent/tsconfig.json --noEmit` and `pnpm --filter api build`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/chat/memory-sanitizer.ts apps/api/src/modules/chat/router.ts packages/agent/src/prompts
git commit -m "feat: sanitize memory tool images, wire image tool + instructions"
```

---

### Task 7: Platform API client — preview images + image URL helper

**Files:**
- Modify: `apps/platform/src/lib/api.ts`

**Interfaces:**
- Consumes: `DocumentPreview` types (existing).
- Produces: `DocumentPageImageInfo = { id; mediaType }`, `DocumentPreviewPage.images?: DocumentPageImageInfo[]`, `buildDocumentImageUrl(documentId: string, pageIndex: number, imageId: string): string` (absolute `${API_BASE}/api/documents/...`), and `isDocumentImagePath(path: string): boolean` (true when the path starts with `/api/documents/` or `${API_BASE}/api/documents/`).

- [ ] **Step 1: Extend types + add helpers**

```ts
export type DocumentPageImageInfo = {
  id: string;
  mediaType: string;
};

export type DocumentPreviewPage = {
  pageIndex: number;
  summary: string;
  rawMarkdown: string;
  images?: DocumentPageImageInfo[];
};

export function buildDocumentImageUrl(
  documentId: string,
  pageIndex: number,
  imageId: string,
): string {
  return `${API_BASE}/api/documents/${encodeURIComponent(documentId)}/pages/${pageIndex}/images/${encodeURIComponent(imageId)}`;
}

export function isDocumentImagePath(value: string): boolean {
  return (
    value.startsWith("/api/documents/") ||
    value.startsWith(`${API_BASE}/api/documents/`)
  );
}

/** Resolve a document-image src (relative or absolute) to a fetchable URL. */
export function resolveDocumentImageUrl(value: string): string {
  return value.startsWith("/api/documents/")
    ? `${API_BASE}${value}`
    : value;
}
```

- [ ] **Step 2: Verify platform typecheck**

Run: `npx tsc -p apps/platform/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/platform/src/lib/api.ts
git commit -m "feat(platform): document image url helpers and preview types"
```

---

### Task 8: Shared `DocumentImage` component (fetch + skeleton + preview trigger)

**Files:**
- Create: `apps/platform/src/components/images/document-image.tsx`
- Create: `apps/platform/src/components/images/image-preview.tsx` (provider + dialog + zoom) — see Task 9; `document-image.tsx` imports `useImagePreview` from it, so create the preview module first in this task's edit order or create both files in Task 8/9 together. Order: Task 9 creates the provider; Task 8 consumes it. Swap order is fine — implement Task 9 first, then Task 8.

**Interfaces:**
- Consumes: `resolveDocumentImageUrl`, `isDocumentImagePath` (Task 7), `useImagePreview` (Task 9).
- Produces: `DocumentImage(props: { src: string; alt?: string; className?: string })` — renders internal images via authenticated fetch + blob URL with skeleton shimmer + error/retry, wraps every image in an accessible preview button.

- [ ] **Step 1: Implement `image-preview.tsx` first** (see Task 9 steps 1-3; provider API: `const { open } = useImagePreview(); open({ src, alt })`).

- [ ] **Step 2: Create `apps/platform/src/components/images/document-image.tsx`**

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  isDocumentImagePath,
  resolveDocumentImageUrl,
} from "#/lib/api";
import { useImagePreview } from "#/components/images/image-preview";

type LoadState = "loading" | "ready" | "error";

export function useDocumentImage(src: string) {
  const internal = isDocumentImagePath(src);
  const [state, setState] = useState<LoadState>(() =>
    internal ? "loading" : "ready",
  );
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!internal) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    setState("loading");

    fetch(resolveDocumentImageUrl(src), { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [src, internal]);

  return { internal, displaySrc: internal ? (objectUrl ?? src) : src, state, retry: setState };
}

export function DocumentImage({
  src,
  alt = "",
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const { open } = useImagePreview();
  const { internal, displaySrc, state, retry } = useDocumentImage(src);

  const openPreview = useCallback(() => {
    open({ src, alt });
  }, [open, src, alt]);

  if (internal && state === "loading") {
    return (
      <div className="my-3 flex flex-col gap-1.5">
        <div className="skeleton-shimmer h-40 w-full max-w-sm rounded-lg" />
        <span className="text-[11px] text-text-faint">Loading image…</span>
      </div>
    );
  }

  if (internal && state === "error") {
    return (
      <div className="my-3 flex items-center gap-2 rounded-lg border border-danger/20 bg-danger-soft px-2.5 py-2">
        <span className="text-[11px] text-danger">Image failed to load.</span>
        <button
          type="button"
          onClick={() => retry("loading")}
          className="rounded-md border border-hairline bg-surface px-1.5 py-0.5 text-[11px] font-medium text-text transition hover:bg-surface-elevated"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={openPreview}
      aria-label={alt ? `View image: ${alt}` : "View image"}
      className="my-3 block max-w-full cursor-zoom-in"
    >
      <img
        src={displaySrc}
        alt={alt}
        loading="lazy"
        className={className ?? "max-h-72 max-w-full rounded-lg border border-white/[0.06] object-contain"}
      />
    </button>
  );
}
```

- [ ] **Step 3: Verify platform typecheck**

Run: `npx tsc -p apps/platform/tsconfig.json --noEmit`
Expected: clean (`retry` type: `setState` dispatch — adjust to `() => setState("loading")` if `retry: setState` misfires types).

- [ ] **Step 4: Commit**

```bash
git add apps/platform/src/components/images
git commit -m "feat(platform): DocumentImage component with authenticated fetch and skeleton"
```

---

### Task 9: Image preview lightbox (zoom, a11y, subtle animation)

**Files:**
- Create: `apps/platform/src/components/images/image-preview.tsx`
- Modify: `apps/platform/src/routes/index.tsx` (mount `ImagePreviewProvider` around the app tree)

**Interfaces:**
- Produces: `ImagePreviewProvider({ children })`, `useImagePreview(): { open: (input: { src: string; alt?: string }) => void }`.

- [ ] **Step 1: Create the provider + dialog**

```tsx
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, RotateCcw, X } from "lucide-react";

type ImagePreviewInput = { src: string; alt?: string };
type ImagePreviewContextValue = { open: (input: ImagePreviewInput) => void };

const ImagePreviewContext = createContext<ImagePreviewContextValue | null>(null);

export function useImagePreview(): ImagePreviewContextValue {
  const context = useContext(ImagePreviewContext);
  if (!context) {
    throw new Error("useImagePreview must be used within ImagePreviewProvider");
  }
  return context;
}

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const ZOOM_STEP = 1.5;

export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ImagePreviewInput | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  const resetView = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const open = useCallback(
    (input: ImagePreviewInput) => {
      setCurrent(input);
      resetView();
    },
    [resetView],
  );

  const close = useCallback(() => {
    dialogRef.current?.close();
    setCurrent(null);
    resetView();
  }, [resetView]);

  const zoomBy = useCallback((factor: number) => {
    setScale((currentScale) =>
      Math.min(MAX_SCALE, Math.max(MIN_SCALE, currentScale * factor)),
    );
  }, []);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (current) {
      if (!dialog.open) {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute("open", "");
        }
      }
      return;
    }
    if (dialog.open) dialog.close();
  }, [current]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!current) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (event.key === "-") {
        event.preventDefault();
        zoomBy(1 / ZOOM_STEP);
      } else if (event.key === "0") {
        resetView();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, zoomBy, resetView]);

  if (typeof window === "undefined") return null;

  const titleId = "image-preview-title";

  return (
    <ImagePreviewContext.Provider value={{ open }}>
      {children}
      {current
        ? createPortal(
            <dialog
              ref={dialogRef}
              aria-labelledby={titleId}
              aria-modal="true"
              className="m-auto flex h-full max-h-[92dvh] w-full max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-hairline bg-canvas-elevated/95 p-0 text-text backdrop-blur-xl shadow-[0_24px_64px_-16px_rgba(0,0,0,0.8)] animate-scale-in motion-reduce:animate-none"
              onCancel={(event) => {
                event.preventDefault();
                close();
              }}
              onClick={(event) => {
                if (event.target === dialogRef.current) close();
              }}
            >
              <h2 id={titleId} className="sr-only">
                {current.alt || "Image preview"}
              </h2>

              <div
                className="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden"
                onWheel={(event) => {
                  event.preventDefault();
                  zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
                }}
                onDoubleClick={() => {
                  zoomBy(scale >= 2 ? 1 / ZOOM_STEP : ZOOM_STEP);
                }}
              >
                <img
                  ref={imageRef}
                  src={current.src}
                  alt={current.alt ?? "Document image"}
                  draggable={false}
                  className="max-h-full max-w-full object-contain transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
                  style={{
                    transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                  }}
                />
              </div>

              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-white/[0.06] px-3 py-2.5">
                <p className="min-w-0 flex-1 truncate text-[11px] text-text-faint">
                  {current.alt || "Document image"}
                </p>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label="Zoom out"
                    onClick={() => zoomBy(1 / ZOOM_STEP)}
                    className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.96] disabled:opacity-40"
                    disabled={scale <= MIN_SCALE}
                  >
                    <Minus className="size-4" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    aria-label="Reset zoom"
                    onClick={resetView}
                    className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.96] disabled:opacity-40"
                    disabled={scale <= MIN_SCALE}
                  >
                    <RotateCcw className="size-4" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    aria-label="Zoom in"
                    onClick={() => zoomBy(ZOOM_STEP)}
                    className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.96] disabled:opacity-40"
                    disabled={scale >= MAX_SCALE}
                  >
                    <Plus className="size-4" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    aria-label="Close image preview"
                    onClick={close}
                    className="ml-1 inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.96]"
                  >
                    <X className="size-4" strokeWidth={1.75} />
                  </button>
                </div>
              </div>
            </dialog>,
            window.document.body,
          )
        : null}
    </ImagePreviewContext.Provider>
  );
}
```

Note: pan is preserved across zoom operations; only `resetView` resets it.

- [ ] **Step 2: Mount the provider in `apps/platform/src/routes/index.tsx`**

Import `ImagePreviewProvider` and wrap the returned tree in `index.tsx` (the root route component render — find the outermost JSX returned by the route component; wrap the `<AppShell>` element):

```tsx
return (
  <ImagePreviewProvider>
    <AppShell>...</AppShell>
  </ImagePreviewProvider>
);
```

- [ ] **Step 3: Verify platform typecheck**

Run: `npx tsc -p apps/platform/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/src/components/images/image-preview.tsx apps/platform/src/routes/index.tsx
git commit -m "feat(platform): accessible image preview lightbox with zoom"
```

---

### Task 10: Chat markdown — inline images with loading indicator

**Files:**
- Modify: `apps/platform/src/components/math-markdown.tsx`

**Interfaces:**
- Consumes: `DocumentImage` (Task 8).
- Produces: `img` component override in `buildMarkdownComponents`.

- [ ] **Step 1: Add `img` component**

Import `DocumentImage`:

```tsx
import { DocumentImage } from "#/components/images/document-image";
```

In `buildMarkdownComponents`, add:

```tsx
img: ({ src, alt, node: _node, ..._props }) => (
  <DocumentImage src={src ?? ""} alt={alt ?? ""} />
),
```

The existing `CHAT_MARKDOWN_CLASS` `[&_img]:...` rules still apply to the inner `<img>`; the wrapping button gets `my-3` from `DocumentImage`.

- [ ] **Step 2: Verify platform typecheck**

Run: `npx tsc -p apps/platform/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/platform/src/components/math-markdown.tsx
git commit -m "feat(platform): render inline document images in chat markdown"
```

---

### Task 11: Tool activity panel — image thumbnails + formatter

**Files:**
- Modify: `apps/platform/src/components/tool-activity-panel.tsx`
- Modify: `apps/platform/src/components/tool-io-format.ts`

**Interfaces:**
- Consumes: `useImagePreview` (Task 9).
- Produces: `extractToolImageParts(output: unknown): Array<{ data: string; mediaType: string }>`; `formatGetDocumentPageImagesInput/Output` registered in `formatToolInput`/`formatToolOutput` switch.

- [ ] **Step 1: Add formatters in `apps/platform/src/components/tool-io-format.ts`**

```ts
function formatGetDocumentPageImagesInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const fields: FormattedField[] = [];

  const documentId = asString(record.documentId);
  if (documentId) fields.push({ label: "Document", value: shortId(documentId) });

  const pageIndex = asNumber(record.pageIndex);
  if (pageIndex !== null) {
    fields.push({ label: "Page", value: formatPage(pageIndex) });
  }

  const limit = asNumber(record.limit);
  if (limit !== null) fields.push({ label: "Limit", value: String(limit) });

  return {
    title: "Request",
    fields,
    emptyText: fields.length === 0 ? "Waiting for request…" : undefined,
  };
}

function formatGetDocumentPageImagesOutput(output: unknown): FormattedSection {
  if (!Array.isArray(output)) return formatGenericOutput(output);

  const textPart = output.find(
    (part): part is { type: "text"; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string",
  );

  if (textPart) {
    try {
      const parsed = JSON.parse(textPart.text) as unknown;
      if (isRecord(parsed)) {
        const found = parsed.found === false;
        if (found) {
          const reason = asString(parsed.reason) ?? "Not available";
          return {
            title: "Result",
            summary: "Not found",
            fields: [{ label: "Reason", value: reason }],
          };
        }

        const imageList = asArray(parsed.images);
        const pageIndex = asNumber(parsed.pageIndex);
        const items: FormattedItem[] = imageList.slice(0, 8).map((entry) => {
          const record = isRecord(entry) ? entry : {};
          const id = asString(record.id) ?? "image";
          const mediaType = asString(record.mediaType) ?? "image";
          return {
            title: id,
            meta: mediaType,
            detail: asString(record.annotation) ?? undefined,
          };
        });

        return {
          title: "Result",
          summary:
            imageList.length === 0
              ? "No images on this page"
              : `${countLabel(imageList.length, "image")}${pageIndex !== null ? ` · ${formatPage(pageIndex)}` : ""}`,
          items: items.length > 0 ? items : undefined,
          emptyText:
            imageList.length === 0 ? "No images extracted for this page." : undefined,
        };
      }
    } catch {
      // Fall through to generic rendering.
    }
  }

  const imageCount = output.filter(
    (part) => isRecord(part) && part.type === "image",
  ).length;
  return {
    title: "Result",
    summary: `${countLabel(imageCount, "image")} returned`,
  };
}
```

Register in both switches:

```ts
case "get_document_page_images":
  return formatGetDocumentPageImagesInput(input);
...
case "get_document_page_images":
  return formatGetDocumentPageImagesOutput(output);
```

- [ ] **Step 2: Render thumbnails in `apps/platform/src/components/tool-activity-panel.tsx`**

Add helper:

```tsx
function extractToolImageParts(
  output: unknown,
): Array<{ data: string; mediaType: string }> {
  if (!Array.isArray(output)) return [];
  return output
    .filter(
      (part): part is { type: "image"; data: string; mediaType?: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "image" &&
        typeof (part as { data?: unknown }).data === "string",
    )
    .map((part) => ({
      data: part.data,
      mediaType: part.mediaType ?? "image/png",
    }));
}
```

Add `TOOL_LABELS` entry: `get_document_page_images: "Inspecting page images"`.

In `ToolActivityPanel`, after the `resultSection` `ToolSectionView`, render thumbnails:

```tsx
{isDone ? (
  <ToolResultImages output={parseToolValue(part.output)} />
) : null}
```

Create `ToolResultImages` (same file):

```tsx
function ToolResultImages({ output }: { output: unknown }) {
  const { open } = useImagePreview();
  const images = extractToolImageParts(output);
  if (images.length === 0) return null;

  return (
    <div className="grid grid-cols-3 gap-2" role="list" aria-label="Result images">
      {images.map((image, index) => (
        <button
          key={`${image.mediaType}-${index}`}
          type="button"
          role="listitem"
          aria-label={`View result image ${index + 1}`}
          onClick={() =>
            open({
              src: `data:${image.mediaType};base64,${image.data}`,
              alt: `Result image ${index + 1}`,
            })
          }
          className="cursor-zoom-in overflow-hidden rounded-lg border border-white/[0.06] transition hover:border-white/[0.14] active:scale-[0.98]"
        >
          <img
            src={`data:${image.mediaType};base64,${image.data}`}
            alt=""
            loading="lazy"
            className="aspect-video w-full object-cover"
          />
        </button>
      ))}
    </div>
  );
}
```

Add `import { useImagePreview } from "#/components/images/image-preview";`.

- [ ] **Step 3: Verify platform typecheck**

Run: `npx tsc -p apps/platform/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/src/components/tool-activity-panel.tsx apps/platform/src/components/tool-io-format.ts
git commit -m "feat(platform): show document image thumbnails in tool activity"
```

---

### Task 12: Document preview pane — page images

**Files:**
- Modify: `apps/platform/src/components/documents/document-preview-pane.tsx`

**Interfaces:**
- Consumes: `DocumentPreviewPage.images` (Task 7), `buildDocumentImageUrl` (Task 7), `useImagePreview` (Task 9).

- [ ] **Step 1: Render page images under the page markdown**

Add import: `import { buildDocumentImageUrl, type DocumentPageImageInfo } from "#/lib/api";` and `import { useImagePreview } from "#/components/images/image-preview";`.

In `DocumentPreviewPane`, add `const { open } = useImagePreview();` and, inside the page `<section>` after the `DocumentMarkdown` block, add:

```tsx
{page.images && page.images.length > 0 ? (
  <div className="grid grid-cols-2 gap-2" aria-label={`Images on page ${page.pageIndex + 1}`}>
    {page.images.map((image: DocumentPageImageInfo) => (
      <button
        key={image.id}
        type="button"
        aria-label={`View image ${image.id}`}
        onClick={() =>
          open({
            src: buildDocumentImageUrl(document.id, page.pageIndex, image.id),
            alt: `Image ${image.id} — page ${page.pageIndex + 1}`,
          })
        }
        className="group cursor-zoom-in overflow-hidden rounded-lg border border-white/[0.06] transition hover:border-white/[0.14]"
      >
        <img
          src={buildDocumentImageUrl(document.id, page.pageIndex, image.id)}
          alt=""
          loading="lazy"
          className="w-full object-cover transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        />
      </button>
    ))}
  </div>
) : null}
```

Note: `<img>` with the app's own origin URL works without the fetch wrapper only if cookies flow — the API is cross-origin, so these `<img>` tags would miss credentials. To stay correct, wrap with the internal-fetch path instead: replace the raw `<img>` above with `DocumentImage` from Task 8:

```tsx
{page.images && page.images.length > 0 ? (
  <div className="grid grid-cols-2 gap-2">
    {page.images.map((image: DocumentPageImageInfo) => (
      <DocumentImage
        key={image.id}
        src={buildDocumentImageUrl(document.id, page.pageIndex, image.id)}
        alt={`Image ${image.id} — page ${page.pageIndex + 1}`}
        className="aspect-video w-full object-cover"
      />
    ))}
  </div>
) : null}
```

`DocumentImage` already opens the preview on click.

- [ ] **Step 2: Verify platform typecheck**

Run: `npx tsc -p apps/platform/tsconfig.json --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/platform/src/components/documents/document-preview-pane.tsx
git commit -m "feat(platform): show OCR page images in document preview"
```

---

### Task 13: Full verification pass

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + build all workspaces**

Run:
- `npx tsc -p packages/agent/tsconfig.json --noEmit`
- `pnpm --filter api build`
- `npx tsc -p apps/platform/tsconfig.json --noEmit`
- `pnpm --filter platform build`

Expected: all clean, no errors or warnings.

- [ ] **Step 2: Prisma migration**

Run: `pnpm --filter api db:migrate` (requires local Postgres). If the DB is unavailable, run `pnpm --filter api db:deploy` after provisioning, or apply `migration.sql` manually — document which path was used.

- [ ] **Step 3: Manual smoke checklist**

1. Upload an image-rich PDF/image in a global chat → poll status until `ready`; confirm worker logs show image uploads and `DocumentPage.images` rows populated. **Also grep a `rawMarkdown` value and a Qdrant chunk for `data:image`** — if Mistral embeds base64 data URLs inside the page markdown itself, file a follow-up to strip them before persist (final-review finding; the memory sanitizer only strips image content PARTS, not base64 inside text).
2. Ask a question requiring a visual ("what does the chart on page 2 show?") → tool `get_document_page_images` appears with thumbnails; assistant answer may embed `![](...)` mid-stream with skeleton indicator.
3. Open document preview → images render per page; click → lightbox opens; test zoom buttons, wheel zoom, double-click, `+`/`-`/`0`, `Escape`, focus return, drag-pan when zoomed.
4. Repeat steps 1–3 in a **project chat** — same behavior (shared components/tooling).
5. Reload chat history → tool cards show text summary (no base64 blobs in network/DB).
6. Check `memorySession.messages` JSON in Postgres → no `"type":"image"` parts.
7. Delete the document → page image R2 objects removed (no 403/404 leakage after deletion).

- [ ] **Step 4: Final commit if any fixes were needed; otherwise done.**

```bash
git status
git add -A
git commit -m "chore: verification fixes for OCR document images"
```

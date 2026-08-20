# Web Image Photos in Chat, Gallery & Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist web photos the agent viewed via `view_image` into `GeneratedImage` (tagged `source="web"` + `sourceUrl`), render them inline in the chat message, in the gallery modal "Images", and in the right-rail "Images" section (mixed with generated images), each web photo carrying a source chip (bottom-left globe; click opens source in new tab; hover reveals the URL capped at half the image width, one line).

**Architecture:** Reuse the existing `GeneratedImage` table + R2 so every consumer that lists session images (gallery modal, right rail, chat inline thumbnails) picks up web photos with no structural UI change. `view_image` (vision + description modes, URL path only) dedups by `(sessionId, sourceUrl)`, stores the raster bytes via `store.saveGeneratedImage`, and returns an `images[{imageId}]` payload the UI parses. The frontend treats `view_image` as a message image tool so it renders the same thumbnail/strip, and `GeneratedImageThumbnail` gains a source chip for `source === "web"`.

**Tech Stack:** TypeScript 7, pnpm 10, Prisma 7 (Postgres), R2, Vitest 4, React 19, Tailwind CSS 4, lucide-react, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-20-web-image-photos-chat-gallery-design.md`

## Global Constraints

- Package manager: `pnpm@10.30.3` (`packageManager` in root `package.json`).
- Prisma 7 with driver adapter (`PrismaPg`); migrations via `pnpm --filter api db:migrate` (dev) / `db:deploy`.
- Do not downgrade: `@types/node ^26.1.1`, TS `^7.0.2`, Vitest `^4.1.10`, `@anvia/core ^0.25.1`, `zod ^4.4.3`.
- Boundaries: `packages/agent` stays pure (no `apps/api` imports); `apps/api` may import from `@assingment/agent`.
- R2 env (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`) required for E2E persistence assertion (same prerequisite as existing image-generation E2E).
- E2E: stack must run with `PORT=3001`, `BETTER_AUTH_URL=http://localhost:3001`; LLM stub on `http://127.0.0.1:18765` (see `apps/platform/e2e/stub-openrouter.ts`), webServer disabled (manual stack), `reuseExistingServer` true.
- Quality gates: `pnpm --filter api test`, `pnpm --filter @assingment/agent test`, `pnpm --filter platform test`, `tsc --noEmit` for api/agent/platform, `npx playwright test e2e/web-search-image-view.e2e.ts` (headed, chromium), real-LLM hands-on when keyed.
- UI style: existing glass/rounded vocabulary (e.g. pin button `bg-black/60 text-white/85 backdrop-blur-sm rounded-md`), lucide icons, Tailwind v4 arbitrary values.

---

## File Structure

**Modified (backend):**
- `apps/api/prisma/schema.prisma` — `GeneratedImage` + `source`, `sourceUrl`, index `[sessionId, source]`
- `apps/api/src/modules/images/service.ts` — `GeneratedImageRecord` fields, `saveGeneratedImage` input, new `findSessionImageBySourceUrl`
- `apps/api/src/modules/images/service.test.ts`
- `apps/api/src/modules/chat/vision-helper.ts` — `projectId` option, `imageDimensionsFromBuffer`, persist web photo, output contract
- `apps/api/src/modules/chat/vision-helper.test.ts`
- `apps/api/src/modules/chat/build-run-input.ts` — pass `projectId` to `createDefaultViewImageTool`
- `apps/api/src/modules/images/router.ts` — `toImageMetadata` now includes `source`/`sourceUrl` (type-only, no logic change)

**Modified (frontend):**
- `apps/platform/src/lib/api.ts` — `GeneratedImageMeta` + guard
- `apps/platform/src/lib/chat/generated-images.ts` — `GeneratedImageItem` fields, `isMessageImageToolName`, `view_image` parsing in `collectGeneratedImages`, `toItem`
- `apps/platform/src/lib/chat/generated-images.test.ts`
- `apps/platform/src/components/chat/chat-message-row.tsx` — image-run grouping uses `isMessageImageToolName`
- `apps/platform/src/components/tool-activity-panel.tsx` — suppress `ToolResultImages` for `view_image`
- `apps/platform/src/components/images/generated-image-thumbnail.tsx` — source chip
- `apps/platform/src/components/images/image-gallery-modal.tsx` — description text
- `apps/platform/src/routes/index.tsx` — `refreshSessionImages()` on stream settle
- `apps/platform/e2e/web-search-image-view.e2e.ts` — persistence + rail chip assertions

---

### Task 1: Schema + image store (`source`, `sourceUrl`, dedup)

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/modules/images/service.ts`
- Modify: `apps/api/src/modules/images/service.test.ts`

**Interfaces:**
- Consumes: existing `createImageStore(deps)`.
- Produces: `GeneratedImageRecord` gains `source: string` and `sourceUrl: string | null`; `saveGeneratedImage(input)` gains optional `source?` (default `"generated"`) and `sourceUrl?`; new `findSessionImageBySourceUrl(input: { userId: string; sessionId: string; sourceUrl: string }): Promise<GeneratedImageRecord | null>`.

- [ ] **Step 1: Write failing service tests**

In `apps/api/src/modules/images/service.test.ts`, extend `setup()`'s fake prisma (already has `generatedImage.create/findMany/findFirst`) and add:

```ts
it("persists source and sourceUrl when saving a web photo", async () => {
  const { fakePrisma, store } = setup();
  fakePrisma.generatedImage.create.mockResolvedValue({
    ...makeRecord(),
    source: "web",
    sourceUrl: "https://example.com/photo.png",
  });
  const record = await store.saveGeneratedImage({
    userId: USER_ID,
    sessionId: SESSION_ID,
    projectId: PROJECT_ID,
    buffer: new Uint8Array([1, 2, 3]),
    mediaType: "image/png",
    width: 0,
    height: 0,
    modelId: "web",
    prompt: "https://example.com/photo.png",
    source: "web",
    sourceUrl: "https://example.com/photo.png",
  });
  expect(fakePrisma.generatedImage.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      source: "web",
      sourceUrl: "https://example.com/photo.png",
    }),
  });
  expect(record.sourceUrl).toBe("https://example.com/photo.png");
});

it("defaults source to generated when omitted", async () => {
  const { fakePrisma, store } = setup();
  fakePrisma.generatedImage.create.mockResolvedValue(makeRecord());
  await store.saveGeneratedImage({
    userId: USER_ID, sessionId: SESSION_ID, projectId: null,
    buffer: new Uint8Array([1]), mediaType: "image/png",
    width: 1, height: 1, modelId: "m", prompt: "p",
  });
  expect(fakePrisma.generatedImage.create).toHaveBeenCalledWith({
    data: expect.objectContaining({ source: "generated" }),
  });
});

it("findSessionImageBySourceUrl queries the generatedImage store by sourceUrl", async () => {
  const { fakePrisma, store } = setup();
  const row = { ...makeRecord(), source: "web", sourceUrl: "https://example.com/a.png" };
  fakePrisma.generatedImage.findFirst.mockResolvedValue(row);
  const found = await store.findSessionImageBySourceUrl({
    userId: USER_ID, sessionId: SESSION_ID, sourceUrl: "https://example.com/a.png",
  });
  expect(fakePrisma.generatedImage.findFirst).toHaveBeenCalledWith({
    where: { userId: USER_ID, sessionId: SESSION_ID, sourceUrl: "https://example.com/a.png" },
  });
  expect(found).toEqual(row);
});
```

Also update `makeRecord` to include the new fields:
`source: "generated", sourceUrl: null,` (inside the returned object) and `makeRecord({ source: "web", sourceUrl: "..." })` remains overridable.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter api exec vitest run src/modules/images/service.test.ts`
Expected: FAIL — `source`/`sourceUrl` not on `GeneratedImageRecord`; `findSessionImageBySourceUrl` not a function.

- [ ] **Step 3: Migrate schema**

In `apps/api/prisma/schema.prisma`, `model GeneratedImage` add:

```prisma
  /// "generated" (image tools) or "web" (view_image of a public web URL).
  source     String  @default("generated")
  sourceUrl  String?
```
and extend the `@@index([sessionId])` area with `@@index([sessionId, source])`.

Run: `pnpm --filter api db:generate` then `pnpm --filter api db:migrate -- --name web_photo_source`

- [ ] **Step 4: Implement service changes**

In `apps/api/src/modules/images/service.ts`:

- `GeneratedImageRecord`: add `source: string; sourceUrl: string | null;`
- `saveGeneratedImage(input: { ...; source?: string; sourceUrl?: string })` — inside `create` data add:
```ts
source: input.source ?? "generated",
...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
```
- Add method on the returned store object:
```ts
async findSessionImageBySourceUrl(input: {
  userId: string;
  sessionId: string;
  sourceUrl: string;
}): Promise<GeneratedImageRecord | null> {
  return deps.prisma.generatedImage.findFirst({
    where: {
      userId: input.userId,
      sessionId: input.sessionId,
      sourceUrl: input.sourceUrl,
    },
  });
},
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter api exec vitest run src/modules/images/service.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/src/modules/images/service.ts apps/api/src/modules/images/service.test.ts apps/api/prisma/migrations
git commit -m "feat(api): GeneratedImage source/sourceUrl columns + findSessionImageBySourceUrl dedup"
```

---

### Task 2: `view_image` persists web photos + output contract

**Files:**
- Modify: `apps/api/src/modules/chat/vision-helper.ts`
- Modify: `apps/api/src/modules/chat/vision-helper.test.ts`

**Interfaces:**
- Consumes: Task 1 `store.saveGeneratedImage`, `store.findSessionImageBySourceUrl`; existing `loadRemoteImage`, `sniffImageMediaType`, `ViewImageToolOptions`.
- Produces:
  - `ViewImageToolOptions` gains `projectId?: string | null`.
  - Exported `imageDimensionsFromBuffer(buffer: Buffer, mediaType: string): { width: number; height: number }`.
  - `createViewImageTool` URL-path success (vision + description) stores the photo and returns a payload with `images: Array<{ imageId, modelId, prompt, width, height, mediaType, index, total }>` plus `sourceUrl`:
    - vision: `[{ type: "text", text: JSON.stringify({ images, sourceUrl }) }, { type: "image", data, mediaType }]`
    - description: `JSON.stringify({ images, description: <text>, sourceUrl })`

- [ ] **Step 1: Write failing tests**

In `apps/api/src/modules/chat/vision-helper.test.ts`, add to `makeOptions` a `store` that also exposes `saveGeneratedImage` and `findSessionImageBySourceUrl` (keep existing `getImage`/`getObjectBuffer`):

```ts
store: {
  getImage: vi.fn(async () => null),
  getObjectBuffer: vi.fn(async () => new Uint8Array([1, 2, 3])),
  saveGeneratedImage: vi.fn(async (input: Record<string, unknown>) => ({
    id: "web-img-1", userId: USER, sessionId: SESSION, projectId: null,
    r2Key: "images/user-1/web-1", mediaType: "image/png", width: 0, height: 0,
    modelId: "web", prompt: String(input.prompt), nOfTotal: null,
    source: "web", sourceUrl: String(input.sourceUrl), createdAt: new Date(),
  })),
  findSessionImageBySourceUrl: vi.fn(async () => null),
} as unknown as ImageStore,
```

Add tests in `describe("view_image universal")`:

```ts
it("persists a web URL photo (vision mode) and returns imageId in the text JSON", async () => {
  const fakeFetch = vi.fn(async () =>
    new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), { status: 200, headers: { "content-type": "image/jpeg" } }),
  );
  const store = makeOptions({ mode: "vision", fetchFn: fakeFetch as never }).store as unknown as {
    saveGeneratedImage: ReturnType<typeof vi.fn>;
    findSessionImageBySourceUrl: ReturnType<typeof vi.fn>;
  };
  const tool = createViewImageTool(makeOptions({ mode: "vision", fetchFn: fakeFetch as never }));
  const result = (await tool.call({ url: "https://example.com/photo.jpg" })) as ToolResultContent[];
  expect(store.saveGeneratedImage).toHaveBeenCalledWith(expect.objectContaining({
    source: "web", sourceUrl: "https://example.com/photo.jpg", modelId: "web",
  }));
  const text = result.find((p) => p.type === "text");
  const parsed = JSON.parse((text as { text: string }).text) as { images: Array<{ imageId: string }> };
  expect(parsed.images[0]!.imageId).toBe("web-img-1");
});

it("reuses an existing record when the same URL was already seen (dedup)", async () => {
  const fakeFetch = vi.fn(async () =>
    new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), { status: 200, headers: { "content-type": "image/jpeg" } }),
  );
  const store = makeOptions({ mode: "vision", fetchFn: fakeFetch as never }).store as unknown as {
    saveGeneratedImage: ReturnType<typeof vi.fn>;
    findSessionImageBySourceUrl: ReturnType<typeof vi.fn>;
  };
  store.findSessionImageBySourceUrl.mockResolvedValue({ id: "existing-1", userId: USER, sessionId: SESSION, projectId: null, r2Key: "r", mediaType: "image/jpeg", width: 0, height: 0, modelId: "web", prompt: "p", nOfTotal: null, source: "web", sourceUrl: "https://example.com/photo.jpg", createdAt: new Date() } as never);
  const tool = createViewImageTool(makeOptions({ mode: "vision", fetchFn: fakeFetch as never }));
  await tool.call({ url: "https://example.com/photo.jpg" });
  expect(store.saveGeneratedImage).not.toHaveBeenCalled();
});

it("description mode returns JSON with images and description", async () => {
  const fakeFetch = vi.fn(async () =>
    new Response(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), { status: 200, headers: { "content-type": "image/jpeg" } }),
  );
  const tool = createViewImageTool(makeOptions({ mode: "description", fetchFn: fakeFetch as never }));
  const output = (await tool.call({ url: "https://example.com/photo.jpg" })) as string;
  const parsed = JSON.parse(output) as { images: unknown[]; description: string; sourceUrl: string };
  expect(parsed.description).toBe("A chart showing quarterly revenue.");
  expect(parsed.sourceUrl).toBe("https://example.com/photo.jpg");
  expect(Array.isArray(parsed.images)).toBe(true);
});

it("does NOT persist an imageId-path (session/document) view", async () => {
  const store = makeOptions({ mode: "vision" }).store as unknown as {
    saveGeneratedImage: ReturnType<typeof vi.fn>;
  };
  const resolveDoc = vi.fn(async () => ({ mediaType: "image/png", buffer: new Uint8Array([9, 9, 9]) }));
  const tool = createViewImageTool(makeOptions({ mode: "vision", resolveDocumentImage: resolveDoc, store: store as never }));
  await tool.call({ imageId: "doc-img-1" });
  expect(store.saveGeneratedImage).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter api exec vitest run src/modules/chat/vision-helper.test.ts`
Expected: FAIL — `saveGeneratedImage` not called; vision output text is not a JSON with `images`.

- [ ] **Step 3: Add `imageDimensionsFromBuffer` + `projectId` option**

In `vision-helper.ts` add:

```ts
/** Parse width/height from common raster headers; fall back to 0x0. */
export function imageDimensionsFromBuffer(
  buffer: Buffer,
  _mediaType: string,
): { width: number; height: number } {
  // PNG: IHDR at offset 16, big-endian.
  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG: scan for SOF0/SOF2 (0xFFC0/0xFFC2) markers.
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    for (let i = 2; i + 9 < buffer.length; i += 1) {
      if (buffer[i] === 0xff && (buffer[i + 1] === 0xc0 || buffer[i + 1] === 0xc2)) {
        return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      }
    }
    return { width: 0, height: 0 };
  }
  // GIF: logical screen descriptor, little-endian.
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  return { width: 0, height: 0 };
}
```

`ViewImageToolOptions`: add `projectId?: string | null;` and destructure `projectId = null` in `createViewImageTool`.

- [ ] **Step 4: Implement persistence + output contract in `createViewImageTool.execute`**

Inside `execute`, after `loaded` succeeds and before the mode branch, only when `url` is provided (not `imageId`):

```ts
let persistedImageId: string | undefined;
let persistedSourceUrl: string | undefined;
if (url) {
  persistedSourceUrl = url;
  const existing = await store.findSessionImageBySourceUrl({
    userId, sessionId, sourceUrl: url,
  }).catch(() => null);
  if (existing) {
    persistedImageId = existing.id;
  } else {
    const dims = imageDimensionsFromBuffer(loaded.buffer, loaded.mediaType);
    try {
      const saved = await store.saveGeneratedImage({
        userId, sessionId, projectId, buffer: loaded.buffer,
        mediaType: loaded.mediaType, width: dims.width, height: dims.height,
        modelId: "web", prompt: question ?? url, source: "web", sourceUrl: url,
      });
      persistedImageId = saved.id;
    } catch (error) {
      console.error("[chat] view_image persist failed", { url, error });
    }
  }
}

const images = persistedImageId
  ? [{
      imageId: persistedImageId,
      modelId: "web",
      prompt: question ?? url,
      width: 0,
      height: 0,
      mediaType: loaded.mediaType,
      index: 0,
      total: 1,
    }]
  : undefined;
```

Then replace the mode branches:

```ts
if (mode === "vision") {
  const content: ToolResultContent[] = images
    ? [{ type: "text", text: JSON.stringify({ images, sourceUrl: persistedSourceUrl }) }]
    : [];
  content.push({ type: "image", data: loaded.buffer.toString("base64"), mediaType: loaded.mediaType });
  return content;
}
const result = await createCompletion(model, {
  messages: [
    Message.user([
      UserContent.imageBase64(loaded.buffer.toString("base64"), loaded.mediaType, { detail: "auto" }),
      UserContent.text(question ?? "Describe this image accurately and concisely."),
    ]),
  ],
  instructions: VIEW_IMAGE_INSTRUCTIONS,
});
return images
  ? JSON.stringify({ images, description: result.text, sourceUrl: persistedSourceUrl })
  : result.text;
```

Keep the existing error branches unchanged (vision → `[{type:"text", text:error}]`, description → error string).

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter api exec vitest run src/modules/chat/vision-helper.test.ts`
Expected: PASS (existing 7 + 4 new). Then `pnpm --filter api exec tsc --noEmit` → 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/chat/vision-helper.ts apps/api/src/modules/chat/vision-helper.test.ts
git commit -m "feat(api): view_image persists web photos (source=web) and returns images[imageId]"
```

---

### Task 3: Wire `projectId` + API metadata passthrough

**Files:**
- Modify: `apps/api/src/modules/chat/build-run-input.ts:483-520`
- Modify: `apps/api/src/modules/images/router.ts:11-20`

**Interfaces:**
- Consumes: Task 2 `ViewImageToolOptions.projectId`.
- Produces: `createDefaultViewImageTool` receives `projectId`; `GET /api/images` metadata includes `source`/`sourceUrl`.

- [ ] **Step 1: Pass `projectId` in both wiring points**

In `build-run-input.ts`, both `createDefaultViewImageTool({ userId, sessionId, model, resolveDocumentImage, mode })` calls add `projectId,` (the local `projectId` variable is already in scope — see line 268).

- [ ] **Step 2: Confirm router passthrough**

`apps/api/src/modules/images/router.ts:12` `toImageMetadata` already spreads the record minus `r2Key`, so `source`/`sourceUrl` flow to clients automatically. Add a comment noting the new fields. No logic change.

- [ ] **Step 3: Verify**

Run: `pnpm --filter api exec tsc --noEmit` → 0; `pnpm --filter api test` → PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/chat/build-run-input.ts apps/api/src/modules/images/router.ts
git commit -m "feat(api): pass projectId to view_image store; expose source/sourceUrl in image metadata"
```

---

### Task 4: Frontend types + `view_image` collection parsing

**Files:**
- Modify: `apps/platform/src/lib/api.ts:1210-1221, 1336-1350`
- Modify: `apps/platform/src/lib/chat/generated-images.ts`
- Modify: `apps/platform/src/lib/chat/generated-images.test.ts`

**Interfaces:**
- Consumes: backend `GET /api/images` now returns `source`/`sourceUrl`.
- Produces:
  - `GeneratedImageMeta` gains `source: string; sourceUrl: string | null`.
  - `GeneratedImageItem` gains `source: string; sourceUrl: string | null`.
  - `isMessageImageToolName(name: string): boolean` (= `isImageToolName(name) || name === "view_image"`).
  - `collectGeneratedImages`/`collectGeneratedImagesFromMessages`/`countRunningImageToolParts`/`groupImageToolRuns`/`mergeGeneratedImages` treat `view_image` as an image tool and parse its output (vision array → text JSON; description JSON string).

- [ ] **Step 1: Write failing frontend tests**

In `apps/platform/src/lib/chat/generated-images.test.ts` add:

```ts
it("collects a view_image web photo from a vision ToolResultContent output", () => {
  const parts = [{
    type: "tool",
    toolName: "view_image",
    state: "output-available",
    output: [
      { type: "text", text: JSON.stringify({ images: [{ imageId: "w1", modelId: "web", prompt: "q", width: 0, height: 0, mediaType: "image/jpeg", index: 0, total: 1 }], sourceUrl: "https://example.com/a.jpg" }) },
      { type: "image", data: "aGk=", mediaType: "image/jpeg" },
    ],
  }];
  const images = collectGeneratedImagesFromMessages([{ parts } as never]);
  expect(images).toHaveLength(1);
  expect(images[0]).toMatchObject({ imageId: "w1", mediaType: "image/jpeg" });
});

it("collects a view_image web photo from a description JSON string output", () => {
  const parts = [{
    type: "tool", toolName: "view_image", state: "output-available",
    output: JSON.stringify({ images: [{ imageId: "w2", modelId: "web", prompt: "q", width: 0, height: 0, mediaType: "image/png", index: 0, total: 1 }], description: "A cat", sourceUrl: "https://example.com/c.png" }),
  }];
  const images = collectGeneratedImagesFromMessages([{ parts } as never]);
  expect(images).toHaveLength(1);
  expect(images[0]!.imageId).toBe("w2");
});

it("isMessageImageToolName includes view_image", () => {
  expect(isMessageImageToolName("view_image")).toBe(true);
  expect(isMessageImageToolName("generate_image")).toBe(true);
  expect(isMessageImageToolName("web_search")).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter platform test -- src/lib/chat/generated-images.test.ts`
Expected: FAIL — `collectGeneratedImages` ignores `view_image`; `isMessageImageToolName` undefined.

- [ ] **Step 3: Implement**

In `apps/platform/src/lib/api.ts`:
- `GeneratedImageMeta`: add `source: string; sourceUrl: string | null;`
- `isGeneratedImageMeta`: add `typeof value.source === "string" && (value.sourceUrl === null || typeof value.sourceUrl === "string")`.

In `apps/platform/src/lib/chat/generated-images.ts`:
- `GeneratedImageItem`: add `source: string; sourceUrl: string | null;`
- `CollectedGeneratedImage`: add `source: string; sourceUrl: string | null;`
- Add:
```ts
export function isMessageImageToolName(name: string): boolean {
  return isImageToolName(name) || name === "view_image";
}
```
- In `collectGeneratedImages`, replace the tool filter with `isMessageImageToolName(part.toolName)` and, for `view_image` parts, parse the images:

```ts
let rawImages: unknown[] = [];
if (part.toolName === "view_image") {
  if (Array.isArray(parsed)) {
    const textPart = parsed.find(
      (p): p is { type: "text"; text: string } =>
        isRecord(p) && p.type === "text" && typeof p.text === "string",
    );
    if (textPart) {
      try {
        const json = JSON.parse(textPart.text) as unknown;
        if (isRecord(json) && Array.isArray(json.images)) rawImages = json.images;
      } catch { /* malformed — ignore */ }
    }
  } else if (isRecord(parsed) && Array.isArray(parsed.images)) {
    rawImages = parsed.images;
  }
} else {
  rawImages = isRecord(parsed) && Array.isArray(parsed.images) ? parsed.images : [];
}
```
then iterate `rawImages` (replacing the current `output.images` loop) and add `source: asString(image.source) ?? "generated", sourceUrl: asString(image.sourceUrl)`.
- `toItem`: include `source`/`sourceUrl` from both shapes.
- `countRunningImageToolParts` / `groupImageToolRuns`: use `isMessageImageToolName`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter platform test -- src/lib/chat/generated-images.test.ts`
Expected: PASS. Then `pnpm --filter platform exec tsc --noEmit` → 0.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/lib/api.ts apps/platform/src/lib/chat/generated-images.ts apps/platform/src/lib/chat/generated-images.test.ts
git commit -m "feat(platform): treat view_image as a message image tool; parse web photo imageId"
```

---

### Task 5: Chat inline render (message row + tool panel)

**Files:**
- Modify: `apps/platform/src/components/chat/chat-message-row.tsx`
- Modify: `apps/platform/src/components/tool-activity-panel.tsx`

**Interfaces:**
- Consumes: Task 4 `isMessageImageToolName`, `imageItemsFromToolPart`.
- Produces: a `view_image` tool part renders an inline `GeneratedImageThumbnail`/`Strip`; `ToolResultImages` no longer duplicates it.

- [ ] **Step 1: Update `chat-message-row.tsx`**

Replace the `isImageToolName` filter in the `imageRuns` useMemo (line ~393) with `isMessageImageToolName` (import it). Everything else (strip/thumbnail rendering via `imageItemsFromToolPart`) works unchanged.

- [ ] **Step 2: Update `tool-activity-panel.tsx`**

Import `isMessageImageToolName`. In `ToolActivityPanel`, only render `<ToolResultImages .../>` when the tool is **not** a message-image tool:

```tsx
{isDone && !isMessageImageToolName(part.toolName) ? (
  <ToolResultImages output={parseToolValue(part.output)} />
) : null}
```

- [ ] **Step 3: Verify**

Run: `pnpm --filter platform exec tsc --noEmit` → 0.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/src/components/chat/chat-message-row.tsx apps/platform/src/components/tool-activity-panel.tsx
git commit -m "feat(platform): render view_image photos inline in chat (thumbnail/strip), no duplicate tool-result grid"
```

---

### Task 6: Source chip + gallery copy + stream-settle refresh

**Files:**
- Modify: `apps/platform/src/components/images/generated-image-thumbnail.tsx`
- Modify: `apps/platform/src/components/images/image-gallery-modal.tsx`
- Modify: `apps/platform/src/routes/index.tsx`

**Interfaces:**
- Consumes: Task 4 `GeneratedImageItem.source`/`sourceUrl`.
- Produces: source chip in thumbnails for `source === "web"`; gallery copy; images refresh after each run.

- [ ] **Step 1: Add the source chip to `generated-image-thumbnail.tsx`**

Import `Globe` from `lucide-react`. Add `container-type` to the outer `<button>` (so `cqw` units work): `className="group/thumb relative block w-full ... [container-type:inline-size]"`.

Inside the button, after the prompt gradient overlay `<span>`, add (only for web photos):

```tsx
{image.source === "web" && image.sourceUrl ? (
  <span
    role="button"
    tabIndex={0}
    aria-label="Open image source"
    title={image.sourceUrl}
    onClick={(event) => {
      event.stopPropagation();
      window.open(image.sourceUrl!, "_blank", "noopener,noreferrer");
    }}
    onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopPropagation();
        window.open(image.sourceUrl!, "_blank", "noopener,noreferrer");
      }
    }}
    className="group/source absolute bottom-1 left-1 z-10 inline-flex cursor-pointer items-center gap-1 rounded-md bg-black/60 px-1.5 py-1 text-white/85 backdrop-blur-sm transition hover:bg-black/75 hover:text-white active:scale-[0.94]"
  >
    <Globe className="size-3" strokeWidth={2} />
    <span className="pointer-events-none absolute bottom-full left-0 mb-1.5 max-w-[min(50cqw,12rem)] truncate whitespace-nowrap rounded-md bg-black/75 px-1.5 py-0.5 text-[10px] text-white/90 opacity-0 backdrop-blur-sm transition-opacity duration-150 group-hover/source:opacity-100">
      {image.sourceUrl}
    </span>
  </span>
) : null}
```

Note: follows the existing pin-button pattern (`span role="button"` nested in the tile), glass styling matches, tooltip is `truncate` single-line with `max-w-[min(50cqw,12rem)]` (half the image width, capped at 12rem).

- [ ] **Step 2: Gallery copy**

In `apps/platform/src/components/images/image-gallery-modal.tsx`, change the modal description (near line 83) to `"Images you generated or viewed across chats"`. Title stays `"Images"`.

- [ ] **Step 3: Refresh images on stream settle**

In `apps/platform/src/routes/index.tsx`, in the effect that runs `onStreamSettled()` (around line 1633), add `void refreshSessionImages();` right after `onStreamSettled();` (it is already a stable callback in scope). This makes a newly persisted web photo appear in the rail + gallery without a reload.

- [ ] **Step 4: Verify**

Run: `pnpm --filter platform exec tsc --noEmit` → 0; `pnpm --filter platform test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/components/images/generated-image-thumbnail.tsx apps/platform/src/components/images/image-gallery-modal.tsx apps/platform/src/routes/index.tsx
git commit -m "feat(platform): web photo source chip (globe + hover URL), gallery copy, refresh images on stream settle"
```

---

### Task 7: E2E + real-LLM + full gates

**Files:**
- Modify: `apps/platform/e2e/web-search-image-view.e2e.ts`
- (no stub changes needed — `websearch_view` already triggers `view_image` on `https://httpbin.org/image/png`)

**Interfaces:**
- Consumes: Tasks 1-6. R2 configured (persistence works in E2E).

- [ ] **Step 1: Add E2E persistence + rail assertions**

In `apps/platform/e2e/web-search-image-view.e2e.ts`, add a new test after case 1:

```ts
test("case 6 — web photo persisted as source=web and shown in the rail Images section", async ({ page, request }) => {
  await openFreshChat(page);
  await enableWebSearch(page);
  await sendMessage(page, "cari logo vercel dan lihat detail");
  await waitForRunDone(page);

  const order = toolCallOrder(await stubRequests(request));
  expect(order).toContain("view_image");

  // Persisted to GeneratedImage with source="web"
  const sessionId = await page.evaluate(() => localStorage.getItem("chat.sessionId") ?? "");
  expect(sessionId).toBeTruthy();
  const res = await request.get(`${API_ORIGIN}/api/images?sessionId=${encodeURIComponent(sessionId)}`);
  const data = (await res.json()) as { images: Array<{ source?: string; sourceUrl?: string | null }> };
  const webPhotos = data.images.filter((i) => i.source === "web");
  expect(webPhotos.length).toBeGreaterThan(0);

  // Rail "Images" section shows a thumbnail with the source chip
  const chip = page.getByLabel("Open image source").first();
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Images")).toBeVisible();
});
```

Note: if R2 is not configured the persistence write is skipped by design; this E2E therefore requires `R2_*` env (same as the image-generation E2E suite).

- [ ] **Step 2: Run the E2E suite (headed chromium)**

Boot the stack manually (Postgres up, `PORT=3001`, `BETTER_AUTH_URL=http://localhost:3001`, LLM stub `:18765`), then:

```bash
npx playwright test e2e/web-search-image-view.e2e.ts --project chromium --headed --reporter=list --workers=1
```

Expected: all 6 cases PASS (case 1-5 existing + case 6).

- [ ] **Step 3: Run all unit/type gates**

```bash
pnpm --filter api test
pnpm --filter @assingment/agent test
pnpm --filter platform test
pnpm --filter api exec tsc --noEmit
pnpm --filter @assingment/agent exec tsc --noEmit
pnpm --filter platform exec tsc --noEmit
```

Expected: 0 failures, 0 type errors.

- [ ] **Step 4: Real-LLM hands-on**

With the stack running against real `.env` (OpenRouter + Tavily), open `http://localhost:3000` in headed Chromium and run (vision model + non-vision model):
- prompt: *"Cari logo Vercel di web, panggil view_image pada URL gambarnya, dan ceritakan."*
Verify per spec §7:
1. Photo appears inline in the chat (thumbnail next to `Viewing image`).
2. Photo appears in the right rail "Images" section.
3. Photo appears in the gallery modal (Images).
4. Source chip (globe) is visible bottom-left; click opens the source URL in a new tab; hover shows the URL truncated to one line at ≤ half image width.
5. Multiple `view_image` calls render as a strip, count matches.
6. Non-vision (DeepSeek) run also stores + shows the photo (description path).

- [ ] **Step 5: Update plan checkboxes + commit**

```bash
git add apps/platform/e2e/web-search-image-view.e2e.ts docs/superpowers/plans/2026-08-20-web-image-photos-chat-gallery.md
git commit -m "test(e2e): web photo persisted as source=web and rail chip visible"
```

- [ ] **Step 6: Push + update PR**

```bash
git push
gh pr comment 12 --body "Add-on: web image photos in chat/gallery/sidebar (persist view_image web photos as source=web + source chip). E2E 6/6 + real-LLM verified."
```

---

## Self-Review

- **Spec coverage:** §2 strategy ✓ Task 1-7; §3.1 schema ✓ Task 1; §3.2 service ✓ Task 1; §3.3 vision-helper ✓ Task 2; §3.4 build-run-input ✓ Task 3; §3.5 API passthrough ✓ Task 3; §4.1 api.ts ✓ Task 4; §4.2 generated-images ✓ Task 4; §4.3 chat-message-row ✓ Task 5; §4.4 tool-activity-panel ✓ Task 5; §4.5 source chip ✓ Task 6; §4.6 gallery copy ✓ Task 6; §4.7 rail (no change, list-based) ✓ Task 6 note; §4.8 refresh on settle ✓ Task 6; §5 data flow ✓; §6 edge cases ✓ Task 2 (dedup, imageId path, storage failure, non-raster via existing); §7 testing ✓ Task 7. Multi-URL: out of scope (per-URL, user-confirmed).
- **Placeholder scan:** all code steps contain concrete code; no TBD/TODO.
- **Type consistency:** `findSessionImageBySourceUrl` (Task 1) used in Task 2; `ViewImageToolOptions.projectId` (Task 2) passed in Task 3; `isMessageImageToolName` (Task 4) used in Tasks 5; `GeneratedImageItem.source/sourceUrl` (Task 4) used in Task 6; `images` payload shape `{ imageId, modelId, prompt, width, height, mediaType, index, total }` consistent between Task 2 output and Task 4 parsing.

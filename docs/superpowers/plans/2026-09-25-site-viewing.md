# Agent Site Viewing (fase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent dapat melihat isi dan tampilan pinned site via tool `view_site_page` (cuplikan teks + screenshot Playwright yang di-cache), untuk model vision maupun text-only, dan token mentah hilang dari bubble assistant.

**Architecture:** Definisi tool statis baru di `packages/agent` (frozen surface) + service `viewing.ts` di `apps/api` (excerpt + capture + cache manifest) + wiring di `build-run-input` dengan bump recipe 5→6 + chip assistant di platform. Tidak ada perubahan pada pipeline vision, `view_image`, atau memory sanitizer.

**Tech Stack:** TypeScript, `playwright-core` (Chromium via channel sistem bila ada), zod, vitest, TDD, conventional commits (`feat:`, `fix:`, `docs:`, `test:`).

**Spec:** `docs/superpowers/specs/2026-09-25-site-viewing-design.md` — plan ini berargumen dari spec; executor membaca keduanya.

## Global Constraints

- Frozen tool order: `...SITE_BUILD_TOOL_DEFINITIONS, ...ARTIFACT_TOOL_DEFINITIONS, ...SITE_VIEW_TOOL_DEFINITIONS, ...REPORT_TOOL_DEFINITIONS` — urutan live harus cermin frozen surface.
- Recipe version menjadi `6` di semua tempat (kode + literal test).
- Cuplikan teks: tanpa dependensi baru (hand-roll ±20 baris).
- Screenshot: `playwright-core` saja (bukan `playwright` penuh); `browser.close()` selalu di `finally`.
- Batas capture: viewport 1440×900, `fullPage` cap 16.000px, timeout navigasi 15 dtk / total 30 dtk, PNG ≤ 5 MB, maks 2 browser konkuren + single-flight per `(siteId, version)`.
- Tidak ada string progress template baru; tidak ada perubahan perilaku untuk role selain user/assistant text-part.
- Setiap task diakhiri suite hijau (`vitest run` paket terkait) + `tsc --noEmit` bersih pada file yang disentuh.

## Review Focus

- Path traversal `siteId = ../../etc` → harus ditolak `assertSafeSiteId` sebelum akses disk; uji dengan id jahat.
- Version berstatus `building`/`failed` atau tanpa `index.html` → tanpa capture, pesan eksplisit; uji tiap status.
- `index.html` raksasa (multi-MB) → baca dibatasi sebelum strip (cap 256 KB); uji dengan file 1 MB.
- Dua panggilan konkuren untuk `(siteId, version)` yang sama → satu capture (single-flight); uji dengan browser fake berlatch.
- Token `[@site …]` di dalam fenced code block markdown assistant → harus tetap teks (jangan jadi chip); uji dengan blok ```.

---
## File Structure

- `packages/agent/src/tools/site-viewing.ts` (baru) — definisi statis `SITE_VIEW_TOOL_DEFINITIONS` + skema input. Satu tanggung jawab: permukaan beku tool.
- `packages/agent/src/tools/site-viewing.test.ts` (baru) — kontrak nama + bentuk parameter.
- `packages/agent/src/tools/artifacts.ts` (ubah) — tambah kalimat `view_site_page` ke `PINNED_ARTIFACT_INSTRUCTION`.
- `packages/agent/src/tools/artifacts.test.ts` (ubah) — vektor instruksi baru.
- `packages/agent/src/index.ts` (ubah) — `export * from "./tools/site-viewing.js";`.
- `apps/api/src/modules/static-sites/viewing.ts` (baru) — `resolveSiteVersion`, `extractSiteExcerpt`, `captureSiteScreenshot`, `viewSitePage`. Satu tanggung jawab: baca + capture site.
- `apps/api/src/modules/static-sites/viewing.test.ts` (baru) — excerpt/resolve/cache (browser di-inject).
- `apps/api/src/modules/static-sites/service.ts` (ubah) — field opsional `screenshots` di `SiteManifest`.
- `apps/api/src/modules/artifacts/service.ts` (ubah) — site case tambah `excerpt` + `stableVersion`.
- `apps/api/src/modules/artifacts/service.test.ts` (ubah, bila ada) — asersi field baru. Jika file test service tidak ada, liput via `viewing.test.ts` + wiring test.
- `apps/api/src/modules/chat/build-run-input.ts` (ubah) — frozen array + live tools.
- `apps/api/src/modules/chat/run-recipe.ts` (ubah) — version 5→6.
- Test recipe/order (ubah literal + array): `run-recipe.test.ts:11`, `run-recipe-behavior.test.ts:31,104-123`, `site-build-wiring.test.ts:69,122-133`, `apps/platform/src/lib/chat/anvia-v1-regression.test.ts:75`.
- `apps/platform/src/components/chat/pinned-text-part.tsx` (baru) — `PinnedTextPart({role, text})`: fence-aware split + chips + `MarkdownBody`.
- `apps/platform/src/components/chat/pinned-text-part.test.tsx` (baru).
- `apps/platform/src/components/chat/chat-message-row.tsx` (ubah) — cabang text-part pakai `PinnedTextPart` untuk user+assistant.

---
### Task 1: Definisi statis `view_site_page` + instruksi pin

**Files:**
- Create: `packages/agent/src/tools/site-viewing.ts`
- Create: `packages/agent/src/tools/site-viewing.test.ts`
- Modify: `packages/agent/src/tools/artifacts.ts` (tambah 1 kalimat instruksi)
- Modify: `packages/agent/src/tools/artifacts.test.ts` (vektor instruksi)
- Modify: `packages/agent/src/index.ts` (tambah export)

**Interfaces:**
- Consumes: `createStaticToolDefinition`, `ToolDefinition` dari `./static-definition.js` (pola sama seperti `documents.ts:141-200`).
- Produces: `SITE_VIEW_TOOL_DEFINITIONS: ToolDefinition[]` (diimpor `@anreal/agent` oleh `build-run-input.ts`, `run-recipe-behavior.test.ts`, `site-build-wiring.test.ts`).

- [ ] **Step 1: Tulis test kontrak yang gagal**

```ts
// packages/agent/src/tools/site-viewing.test.ts
import { describe, expect, it } from "vitest";
import { SITE_VIEW_TOOL_DEFINITIONS } from "./site-viewing.js";

describe("SITE_VIEW_TOOL_DEFINITIONS", () => {
  it("exposes exactly view_site_page with siteId/version/question params", () => {
    expect(SITE_VIEW_TOOL_DEFINITIONS.map((d) => d.name)).toEqual(["view_site_page"]);
    const params = SITE_VIEW_TOOL_DEFINITIONS[0]!.parameters as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(params.properties).sort()).toEqual(["question", "siteId", "version"]);
    expect(params.required).toEqual(["siteId"]);
  });
});
```

- [ ] **Step 2: Jalankan dan pastikan gagal**

Run: `pnpm --filter @anreal/agent exec vitest run src/tools/site-viewing.test.ts`
Expected: FAIL dengan "Failed to load" / file tidak ada.

- [ ] **Step 3: Tulis definisi minimal**

```ts
// packages/agent/src/tools/site-viewing.ts
import { z } from "zod";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";

const viewSitePageInput = z.object({
  siteId: z
    .string()
    .min(1)
    .max(120)
    .describe("Site id from a pin or list_artifacts (type site)"),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Site version to view. Omit to use the current stable version."),
  question: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("What to focus on, e.g. 'review the hero section design'"),
});

const viewSitePageSpec = {
  name: "view_site_page",
  description:
    "View a workspace site's content and appearance. Always returns a bounded text excerpt plus provenance (siteId, version, imageId, capturedAt). Vision models receive the screenshot bytes directly; text-only models must pass imageId to view_image for a description. Never ask the user for screenshots.",
  inputSchema: viewSitePageInput,
} as const;

export const SITE_VIEW_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(viewSitePageSpec),
];
```

- [ ] **Step 4: Export dari index + update instruksi pin + test hijau**

```ts
// packages/agent/src/index.ts — tambah di dekat baris 69:
export * from "./tools/site-viewing.js";
```

```ts
// packages/agent/src/tools/artifacts.ts — PINNED_ARTIFACT_INSTRUCTION tambah kalimat:
"To judge a pinned site's content or appearance, call view_site_page after",
"get_artifact. Never ask the user for screenshots.",
```

```ts
// packages/agent/src/tools/artifacts.test.ts — tambah dalam describe instruksi:
expect(PINNED_ARTIFACT_INSTRUCTION).toContain("view_site_page");
```

Run: `pnpm --filter @anreal/agent exec vitest run src/tools/site-viewing.test.ts src/tools/artifacts.test.ts src/tools/tool-contracts.test.ts`
Expected: PASS (kontrak source otomatis mencakup file baru).

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/tools/site-viewing.ts packages/agent/src/tools/site-viewing.test.ts packages/agent/src/tools/artifacts.ts packages/agent/src/tools/artifacts.test.ts packages/agent/src/index.ts
git commit -m "feat(agent): add view_site_page static tool definition"
```

---
### Task 2: `resolveSiteVersion` + `extractSiteExcerpt` (tanpa browser)

**Files:**
- Create: `apps/api/src/modules/static-sites/viewing.ts` (bagian 1)
- Create: `apps/api/src/modules/static-sites/viewing.test.ts` (bagian 1)

**Interfaces:**
- Consumes: `getScopedSite`, `readSiteManifest`, `siteDataDir` dari `./service.js`; `assertSafeSiteId` dari `./service.js`.
- Produces: `resolveSiteVersion(input): Promise<{siteId, version}>`, `extractSiteExcerpt(input): Promise<{title, headings, excerpt, truncated}>` — dipakai Task 3–5.

- [ ] **Step 1: Tulis test resolve + excerpt yang gagal**

```ts
// apps/api/src/modules/static-sites/viewing.test.ts
import { describe, expect, it } from "vitest";
import { extractSiteExcerpt } from "./viewing.js";

describe("extractSiteExcerpt", () => {
  it("strips scripts and tags with a char bound", async () => {
    const html = `<html><head><title>Kedai</title><script>alert(1)</script></head><body><h1>Halo</h1><p>Dunia</p></body></html>`;
    const out = await extractSiteExcerpt({
      readHtml: async () => html,
      maxChars: 20,
    });
    expect(out.title).toBe("Kedai");
    expect(out.excerpt).not.toContain("alert");
    expect(out.excerpt.length).toBeLessThanOrEqual(20);
    expect(out.truncated).toBe(true);
  });
});
```

Catatan: `readHtml` di-inject agar unit test tidak menyentuh disk; implementasi produksi meneruskan pembaca disk (lihat Step 3).

- [ ] **Step 2: Jalankan dan pastikan gagal**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/static-sites/viewing.test.ts`
Expected: FAIL (modul belum ada).

- [ ] **Step 3: Implementasi minimal**

```ts
// apps/api/src/modules/static-sites/viewing.ts
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
  assertSafeSiteId,
  getScopedSite,
  siteDataDir,
} from "./service.js";

export type SiteVersionRef = { siteId: string; version: number };

export async function resolveSiteVersion(input: {
  userId: string;
  sessionProjectId: string | null;
  siteId: string;
  version?: number;
}): Promise<SiteVersionRef> {
  const manifest = await getScopedSite(input.userId, input.sessionProjectId, input.siteId);
  if (!manifest) throw new Error("Site not found in the current scope.");
  const version = input.version ?? manifest.stableVersion ?? manifest.version;
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("Site version not found in the current scope.");
  }
  return { siteId: manifest.siteId, version };
}

const READ_CAP_BYTES = 256 * 1024;

export async function readSiteIndexHtml(ref: SiteVersionRef): Promise<string> {
  assertSafeSiteId(ref.siteId);
  const path = join(siteDataDir(), ref.siteId, `v${ref.version}`, "index.html");
  const handle = await readFile(path, "utf8").catch(() => null);
  // Pola baca-dibatasi: baca penuh lalu potong — file dist statis kecil;
  // cap di sini mencegah OOM bila ada aset raksasa nyasar.
  if (handle === null) throw new Error("Site page has nothing viewable yet.");
  return handle.length > READ_CAP_BYTES ? handle.slice(0, READ_CAP_BYTES) : handle;
}

export function stripHtmlToText(html: string, maxChars: number): {
  title: string;
  headings: string[];
  excerpt: string;
  truncated: boolean;
} {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
  const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => m[1]!.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 20);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    title,
    headings,
    excerpt: text.length > maxChars ? text.slice(0, maxChars) : text,
    truncated: text.length > maxChars,
  };
}

export async function extractSiteExcerpt(input: {
  ref: SiteVersionRef;
  maxChars?: number;
  readHtml?: (ref: SiteVersionRef) => Promise<string>;
}): Promise<{ title: string; headings: string[]; excerpt: string; truncated: boolean }> {
  const html = await (input.readHtml ?? readSiteIndexHtml)(input.ref);
  return stripHtmlToText(html, input.maxChars ?? 6000);
}
```

- [ ] **Step 4: Tambah test resolve-version + traversal, lalu hijaukan**

```ts
it("rejects path traversal before touching disk", async () => {
  await expect(
    resolveSiteVersion({ userId: "u", sessionProjectId: null, siteId: "../../etc", version: 1 }),
  ).rejects.toThrow(/not found/i);
});

it("throws an explicit message for non-ready versions", async () => {
  // memakai manifest fixture berstatus building via dirOverride tmp
});
```

Untuk test status non-ready: buat `site.json` fixture di direktori tmp
(`dirOverride`) dengan `status: "building"`, resolve boleh lolos (capture
yang menolak — Task 3). Test di sini cukup: resolve kembalikan version
konkret untuk manifest valid. Implementasi test fixture mengikuti pola
`download.test.ts` (baca file itu dulu bila ragu).

Run: `pnpm --filter @anreal/api exec vitest run src/modules/static-sites/viewing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/static-sites/viewing.ts apps/api/src/modules/static-sites/viewing.test.ts
git commit -m "feat(api): resolve site version and extract text excerpt"
```

---
### Task 3: Screenshot Playwright + cache manifest + single-flight

**Files:**
- Modify: `apps/api/src/modules/static-sites/viewing.ts` (tambah capture)
- Modify: `apps/api/src/modules/static-sites/viewing.test.ts` (test browser fake)
- Modify: `apps/api/src/modules/static-sites/service.ts` (field `screenshots`)
- Modify: `apps/api/package.json` (tambah `playwright-core`)

**Interfaces:**
- Consumes: `resolveSiteVersion`, `extractSiteExcerpt` (Task 2); `readSiteManifest`, `writeSiteManifest` (`./service.js`); `getImageStore().saveGeneratedImage` (`../images/service.js`, pola sama seperti `snapshotChart` di `build-run-input.ts:1450`).
- Produces: `viewSitePage(input): Promise<{siteId, version, status, excerpt, headings, title, imageId, capturedAt, viewport, fullPage, truncated}>` — dipakai Task 5.

- [ ] **Step 1: Tambah dep + test capture-dengan-browser-fake yang gagal**

```bash
pnpm --filter @anreal/api add playwright-core
```

```ts
// viewing.test.ts — tambah:
it("single-flights concurrent captures into one browser run", async () => {
  let runs = 0;
  const fakeBrowser = {
    newPage: async () => ({
      goto: async () => undefined,
      screenshot: async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 20));
        return new Uint8Array([137, 80, 78, 71]);
      },
      close: async () => undefined,
    }),
    close: async () => undefined,
  };
  const launch = async () => {
    await new Promise((r) => setTimeout(r, 5));
    return fakeBrowser;
  };
  const [a, b] = await Promise.all([
    captureSiteScreenshot({ ref: { siteId: "s", version: 1 }, launch: launch as never, save: async () => ({ id: "img-1" }) as never, loadManifest: async () => null, storeManifest: async () => undefined }),
    captureSiteScreenshot({ ref: { siteId: "s", version: 1 }, launch: launch as never, save: async () => ({ id: "img-1" }) as never, loadManifest: async () => null, storeManifest: async () => undefined }),
  ]);
  expect(runs).toBe(1);
  expect(a.imageId).toBe("img-1");
  expect(b.imageId).toBe("img-1");
});
```

- [ ] **Step 2: Jalankan dan pastikan gagal**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/static-sites/viewing.test.ts`
Expected: FAIL (`captureSiteScreenshot` belum ada).

- [ ] **Step 3: Implementasi capture + field manifest**

```ts
// service.ts — tambah ke SiteManifest:
screenshots?: Record<number, {
  imageId: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  fullPage: boolean;
  truncated: boolean;
}>;
```

```ts
// viewing.ts — tambah (disederhanakan; batas timeout/concurrency di langkah yang sama):
const inflight = new Map<string, Promise<{ imageId: string; capturedAt: string; truncated: boolean }>>();

export async function captureSiteScreenshot(input: {
  ref: SiteVersionRef;
  label: string;
  previewPath: string; // mis. `/api/sites/<id>/v<n>/preview/index.html`
  userId: string;
  sessionId: string;
  projectId: string | null;
  launch?: () => Promise<BrowserLike>;
  save?: (args: { buffer: Uint8Array; width: number; height: number }) => Promise<{ id: string }>;
  loadManifest?: (siteId: string) => Promise<SiteManifest | null>;
  storeManifest?: (manifest: SiteManifest) => Promise<void>;
}): Promise<{ imageId: string; capturedAt: string; truncated: boolean }> {
  const key = `${input.ref.siteId}:v${input.ref.version}`;
  const cached = (await (input.loadManifest ?? readSiteManifest)(input.ref.siteId))?.screenshots?.[input.ref.version];
  if (cached) return { imageId: cached.imageId, capturedAt: cached.capturedAt, truncated: cached.truncated };
  const pending = inflight.get(key);
  if (pending) return pending;
  const run = (async () => {
    const VIEWPORT = { width: 1440, height: 900 };
    const browser = await (input.launch ?? launchChromium)();
    try {
      const page = await browser.newPage({ viewport: VIEWPORT });
      try {
        await page.goto(`http://localhost:4312${input.previewPath}`, { waitUntil: "networkidle", timeout: 15_000 });
        const buffer = Buffer.from(await page.screenshot({ fullPage: true, timeout: 15_000 }));
        const truncated = buffer.length > 5 * 1024 * 1024;
        const saved = await (input.save ?? defaultSave)(input, buffer, VIEWPORT);
        const capturedAt = new Date().toISOString();
        const manifest = await (input.loadManifest ?? readSiteManifest)(input.ref.siteId);
        if (manifest) {
          await (input.storeManifest ?? writeSiteManifest)({
            ...manifest,
            screenshots: { ...(manifest.screenshots ?? {}), [input.ref.version]: { imageId: saved.id, capturedAt, viewport: VIEWPORT, fullPage: true, truncated } },
          });
        }
        return { imageId: saved.id, capturedAt, truncated };
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  })();
  inflight.set(key, run);
  try {
    return await run;
  } finally {
    inflight.delete(key);
  }
}
```

`launchChromium` memakai `playwright-core`: `chromium.launch({ channel: "chrome" })` dengan fallback launch bawaan bila channel gagal; `defaultSave` memanggil `getImageStore().saveGeneratedImage` dengan `mediaType: "image/png"`, `modelId: "site-screenshot"`, `source: "site-screenshot"`, caption `"Screenshot site {label} v{n}"`. Concurrency global: semaphore sederhana maks 2 (counter + antrean FIFO) di modul yang sama. Timeout total: `AbortSignal.timeout(30_000)` membungkus `run`.

- [ ] **Step 4: Test cache-hit tanpa browser + hijau**

```ts
it("returns cached screenshots without launching a browser", async () => {
  const launch = vi.fn();
  const out = await captureSiteScreenshot({
    ref: { siteId: "s", version: 2 },
    label: "Kedai",
    previewPath: "/api/sites/s/v2/preview/index.html",
    userId: "u",
    sessionId: "sess",
    projectId: null,
    launch: launch as never,
    loadManifest: async () => ({ screenshots: { 2: { imageId: "img-9", capturedAt: "t", viewport: { width: 1440, height: 900 }, fullPage: true, truncated: false } } }) as never,
  });
  expect(out.imageId).toBe("img-9");
  expect(launch).not.toHaveBeenCalled();
});
```

Run: `pnpm --filter @anreal/api exec vitest run src/modules/static-sites/viewing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/static-sites/viewing.ts apps/api/src/modules/static-sites/viewing.test.ts apps/api/src/modules/static-sites/service.ts apps/api/package.json
git commit -m "feat(api): cached playwright screenshots for site versions"
```

---
### Task 4: `get_artifact` site sertakan excerpt

**Files:**
- Modify: `apps/api/src/modules/artifacts/service.ts` (site case ≈ baris 226–240)
- Test: liput via test service yang ada; jika tidak ada, tambah ke `viewing.test.ts` pola integrasi `getArtifact` dengan `dirOverride` tmp (ikuti `download.test.ts`).

**Interfaces:**
- Consumes: `extractSiteExcerpt`, `resolveSiteVersion` (Task 2).
- Produces: response site `{…, excerpt, stableVersion}` — dibaca Task 5 + platform tidak berubah (field tambahan diabaikan list lama).

- [ ] **Step 1: Tulis test yang gagal**

```ts
it("includes a bounded excerpt and stableVersion for sites", async () => {
  // setup: tulis site fixture (manifest + v1/index.html) ke dir tmp,
  // panggil getArtifact({userId, sessionProjectId: null, type: "site", id})
  // sebagai unknown record:
  const artifact = (await getArtifact({ ... })) as Record<string, unknown>;
  expect(typeof artifact.excerpt).toBe("string");
  expect((artifact.excerpt as string).length).toBeLessThanOrEqual(2000);
  expect(artifact).toHaveProperty("stableVersion");
});
```

Lihat `download.test.ts` untuk pola fixture `dirOverride` sebelum menulis.

- [ ] **Step 2: Jalankan dan pastikan gagal**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/artifacts/service.test.ts` (atau file test yang dibuat)
Expected: FAIL (`excerpt` undefined).

- [ ] **Step 3: Implementasi minimal**

```ts
// service.ts — dalam case "site", setelah manifest didapat:
const excerpt = await extractSiteExcerpt({
  ref: { siteId: manifest.siteId, version: manifest.version },
  maxChars: 2000,
}).catch(() => null);
return manifest
  ? {
      type: "site",
      id: manifest.siteId,
      siteId: manifest.siteId,
      version: manifest.version,
      stableVersion: manifest.stableVersion,
      status: manifest.status,
      previewUrl: manifest.previewUrl,
      projectId: input.sessionProjectId,
      updatedAt: manifest.updatedAt,
      ...(excerpt ? { excerpt: excerpt.excerpt } : {}),
    }
  : null;
```

- [ ] **Step 4: Hijau + commit**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/artifacts/`
Expected: PASS.

```bash
git add apps/api/src/modules/artifacts/service.ts <file-test>
git commit -m "feat(api): include excerpt in site artifact detail"
```

---
### Task 5: Wiring recipe + bump version 6

**Files:**
- Modify: `apps/api/src/modules/chat/build-run-input.ts` (import, frozen array, live tools)
- Modify: `apps/api/src/modules/chat/run-recipe.ts` (`5 as const` → `6 as const`)
- Modify (literal version): `apps/api/src/modules/chat/run-recipe.test.ts:11`, `run-recipe-behavior.test.ts:31`, `site-build-wiring.test.ts:69`, `apps/platform/src/lib/chat/anvia-v1-regression.test.ts:75` (`version: 5` → `version: 6`)
- Modify (order array): `run-recipe-behavior.test.ts:104-123`, `site-build-wiring.test.ts:122-133` (tambah `...SITE_VIEW_TOOL_DEFINITIONS` setelah `...ARTIFACT_TOOL_DEFINITIONS` + import dari `@anreal/agent`)

**Interfaces:**
- Consumes: `SITE_VIEW_TOOL_DEFINITIONS` (`@anreal/agent`), `viewSitePage`/`captureSiteScreenshot` (Task 3), `focus()` existing (baris 1381).
- Produces: tool live `view_site_page` terdaftar dengan urutan beku benar; recipe v6.

- [ ] **Step 1: Tambah import + frozen array (test parity akan gagal dulu bila array test belum diupdate — itu ekspektasi)**

```ts
// build-run-input.ts — import (di dekat ARTIFACT_TOOL_DEFINITIONS):
SITE_VIEW_TOOL_DEFINITIONS,
// frozen array:
...ARTIFACT_TOOL_DEFINITIONS,
...SITE_VIEW_TOOL_DEFINITIONS,
...REPORT_TOOL_DEFINITIONS,
```

Run: `pnpm --filter @anreal/api exec vitest run src/modules/chat/run-recipe-behavior.test.ts src/modules/chat/site-build-wiring.test.ts`
Expected: FAIL (order test lokal belum memuat tool baru) — konfirmasi wiring terbaca.

- [ ] **Step 2: Live tools setelah artifactTools**

```ts
// build-run-input.ts — setelah tools.push(...artifactTools):
tools.push(
  ...createViewSitePageTools({
    view: (args) =>
      viewSitePage({
        userId,
        sessionId,
        projectId,
        siteId: args.siteId,
        ...(args.version !== undefined ? { version: args.version } : {}),
        ...(args.question !== undefined ? { question: args.question } : {}),
      }),
    onFocus: (f) => focus(f.artifactId, f.artifactType, f.label),
  }),
);
```

`createViewSitePageTools` didefinisikan di `packages/agent/src/tools/site-viewing.ts`? TIDAK — live factory butuh deps server (disk, browser, image store) sehingga tinggal di `apps/api` (file baru `apps/api/src/modules/chat/site-view-tools.ts`, mengikuti bentuk `createArtifactTools`: `createTool({ ...spec, outputSchema, execute })`). Spec (nama/deskripsi/skema) diimpor ulang dari `@anreal/agent` agar single source of truth — tiru cara `createSiteBuildTools` memakai spec terpusat. Jika ragu, baca `site-build.ts` di `packages/agent` sebelum menulis.

- [ ] **Step 3: Bump recipe + update semua literal/order test**

```ts
// run-recipe.ts:
export const CHAT_AGENT_RECIPE_VERSION = 6 as const;
```

Ubah `version: 5` → `version: 6` di 4 file test; tambah spread + import di 2 order array. Run: `pnpm --filter @anreal/api exec vitest run src/modules/chat/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/chat/ apps/api/src/modules/static-sites/viewing.ts
git commit -m "feat(api): wire view_site_page and bump chat recipe to v6"
```

---
### Task 6: Chip untuk token di bubble assistant (platform)

**Files:**
- Create: `apps/platform/src/components/chat/pinned-text-part.tsx`
- Create: `apps/platform/src/components/chat/pinned-text-part.test.tsx`
- Modify: `apps/platform/src/components/chat/chat-message-row.tsx` (cabang text-part)

**Interfaces:**
- Consumes: `splitPinnedText` (ada — `pinned-artifact-chips.tsx`), `PinnedArtifactChips` (ada), `MarkdownBody` (`#/components/math-markdown`, prop `content: string`).
- Produces: `PinnedTextPart({ role, text })` dipakai cabang text-part untuk user + assistant.

- [ ] **Step 1: Test fence-aware split + render yang gagal**

```ts
// pinned-text-part.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PinnedTextPart } from "./pinned-text-part";

describe("PinnedTextPart", () => {
  it("renders chips and strips tokens for user text", () => {
    const html = renderToStaticMarkup(
      <PinnedTextPart role="user" text="Lihat ini [@site Kedai (abc)]" />,
    );
    expect(html).toContain("Kedai");
    expect(html).not.toContain("[@site");
  });

  it("leaves tokens inside fenced code blocks as plain text", () => {
    const html = renderToStaticMarkup(
      <PinnedTextPart role="assistant" text={'Contoh:\n```\n[@site Kedai (abc)]\n```'} />,
    );
    expect(html).not.toContain("Pinned artifacts");
  });

  it("renders chips-only for pin-only assistant text", () => {
    const html = renderToStaticMarkup(
      <PinnedTextPart role="assistant" text="[@document Laporan (d1)]" />,
    );
    expect(html).toContain("Laporan");
  });
});
```

- [ ] **Step 2: Jalankan dan pastikan gagal**

Run: `pnpm --filter @anreal/platform exec vitest run src/components/chat/pinned-text-part.test.tsx`
Expected: FAIL (file belum ada).

- [ ] **Step 3: Implementasi (fence-aware, render-only)**

```tsx
// pinned-text-part.tsx
import { MarkdownBody } from "#/components/math-markdown";
import {
  PinnedArtifactChips,
  splitPinnedText,
} from "#/components/artifacts/pinned-artifact-chips";

function splitOutsideFences(text: string): { cleanText: string; refs: { type: string; id: string; label: string }[] } {
  const segments = text.split(/(```[\s\S]*?```)/g);
  const refs: { type: string; id: string; label: string }[] = [];
  const clean = segments
    .map((segment, index) => {
      if (index % 2 === 1) return segment; // pagar: sentuh
      const { cleanText, refs: found } = splitPinnedText(segment);
      refs.push(...found);
      return cleanText;
    })
    .join("");
  return { cleanText: clean, refs };
}

export function PinnedTextPart({ role, text }: { role: string; text: string }) {
  if (role !== "user" && role !== "assistant") return <MarkdownBody content={text} />;
  const { cleanText, refs } = splitOutsideFences(text);
  if (refs.length === 0) return <MarkdownBody content={text} />;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <PinnedArtifactChips pins={refs} />
      {cleanText.trim() ? <MarkdownBody content={cleanText} /> : null}
    </div>
  );
}
```

Catatan tipe: `PinnedArtifactChips` menerima `PinnedArtifactPin[]`
(`ArtifactType`); selaraskan tipe `refs` (cast `as never` dilarang —
gunakan tipe yang benar dari `#/lib/api-artifacts`).

- [ ] **Step 4: Pakai di row + hijau**

```tsx
// chat-message-row.tsx — ganti isi cabang text-part:
{(part) => {
  if (part.type === "text") {
    return (
      <MessagePrimitive.Part className="min-w-0 max-w-full">
        <PinnedTextPart role={message.role} text={part.text} />
      </MessagePrimitive.Part>
    );
  }
```

Hapus import `splitPinnedText`/`MarkdownBody` yang kini tak terpakai bila
ada; pastikan `MathMarkdown` tidak lagi dipakai di berkas ini (hapus import
bila yatim). Run: `pnpm --filter @anreal/platform exec vitest run src/components/chat/ src/components/artifacts/ src/components/composer/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/components/chat/
git commit -m "feat(platform): render pinned chips in assistant bubbles"
```

---
### Task 7: Verifikasi E2E real-LLM + final

**Files:** tanpa file baru (skrip tmp yang dihapus setelahnya), kecuali bila
ditemukan bug — bug diperbaiki di task pemiliknya, bukan di sini.

- [ ] **Step 1: Suite penuh tiap paket**

Run: `pnpm --filter @anreal/agent exec vitest run`
Run: `pnpm --filter @anreal/api exec vitest run`
Run: `pnpm --filter @anreal/platform exec vitest run`
Expected: semua PASS (kecuali failure pre-existing yang didokumentasikan:
`finalize-interrupted-tools.test.ts`, researcher wait-budget — verifikasi
gagalnya identik sebelum perubahan via `git stash` bila ragu).

- [ ] **Step 2: Typecheck tiap paket**

Run: `pnpm --filter @anreal/api exec tsc --noEmit -p tsconfig.json`
Run: `pnpm --filter @anreal/platform exec tsc --noEmit -p tsconfig.json`
Expected: bersih pada file yang disentuh plan ini.

- [ ] **Step 3: E2E real-LLM vision (muse-spark-1.3)**

Dengan dev stack jalan (`pnpm dev`), model `muse-spark-1.3`: buat site via
chat, pin di sesi baru, minta "review desainnya". Expected: tool call
`view_site_page` terlihat di trace, jawaban merujuk konten visual (bukan
meminta screenshot), bubble assistant tanpa token mentah.

- [ ] **Step 4: E2E real-LLM text-only (deepseek-v4-flash)**

Ulangi Step 3 dengan model text-only. Expected: `view_image(imageId)`
terpanggil setelah `view_site_page`, jawaban berupa deskripsi visual yang
masuk akal.

- [ ] **Step 5: Push branch**

```bash
git push origin feat/workspace-artifacts
```

---

## Self-Review

- **Spec coverage:** §3.1→Task 1; §3.2→Task 2–3; §3.3→Task 5; §3.4→Task 4;
  §3.5→tanpa kode (disengaja — narasi bebas + `toolWaitProgress` existing);
  §3.6→Task 6; §4→Task 3+5 (jalur vision via image block native —
  implementasi injeksi mengikuti `includeImageBytes` existing; bila ternyata
  butuh kode baru, tambah step di Task 5, jangan diam); §5→Task 2–3
  (provenance di return); §6→Task 2–4 (pesan error eksplisit); §7→Task 7;
  §8→Task 7 Step 5.
- **Placeholder scan:** tidak ada TBD/TODO; semua step punya kode/perintah
  run yang konkret. Pengecualian jujur: pola fixture `dirOverride` menunjuk
  ke `download.test.ts` sebagai referensi (bukan placeholder — file ada).
- **Type consistency:** `viewSitePage` return shape konsisten Task 3→5;
  `PinnedArtifactPin` vs `ArtifactType` dicatat eksplisit di Task 6 Step 3;
  `SITE_VIEW_TOOL_DEFINITIONS` diekspor via index (Task 1 Step 4) sebelum
  dipakai test API (Task 5).
- **Review Focus:** lima baris di atas masing-masing punya test di task
  pemilik (traversal→T2, status non-ready→T2/T3, file raksasa→T2
  `READ_CAP_BYTES`, single-flight→T3, code-fence→T6).

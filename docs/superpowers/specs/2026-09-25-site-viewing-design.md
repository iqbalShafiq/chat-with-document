# Spec: Agent Site Viewing (fase 1) — `view_site_page` + cuplikan konten + chip assistant

Tanggal: 2026-09-25. Status: draft untuk review. Scope: fase 1 saja (one-shot
viewing). Live screencast + cursor sintetik = fase 2 eksplisit, di luar spec ini.

## 1. Tujuan

Agent yang diberi pin site (`[@site label (id)]`) harus bisa menjawab tentang
isi dan tampilan site tanpa meminta screenshot ke user. Berlaku untuk model
vision (image block langsung) maupun text-only (via `view_image` mode
description yang sudah ada). Token mentah tidak boleh tampil di bubble
assistant.

Non-tujuan: live browsing loop (scroll/klik multi-turn), iframe-replay
perintah ke client (diverifikasi tidak robust — industri memakai screencast
piksel), adopsi `@anvia/browser` (butuh Docker + menolak localhost di semua
policy mode — diverifikasi dari `navigation-policy.ts` upstream), perubahan
pipeline vision yang sudah ada.

## 2. Arsitektur (ringkas)

```
Agent turn ──▶ view_site_page({siteId, version?})
                 ├─ resolve version (default: stabil saat itu) → version konkret V
                 ├─ baca index.html V dari disk → cuplikan teks (selalu)
                 └─ screenshot V (sekali per version, cache permanen)
                      └─ PNG → image store → imageId
                           ├─ model vision  → image block native (TANPA view_image)
                           └─ model text-only → view_image(imageId) → deskripsi teks
```

Tidak ada komponen baru di pipeline vision: cabang vision/text-only tetap di
gate `modelAcceptsImage` yang sudah ada (`build-run-input.ts:1019`).

## 3. Komponen

### 3.1 Definisi tool statis — `packages/agent/src/tools/site-viewing.ts` (baru)

- `SITE_VIEW_TOOL_DEFINITIONS` via `createStaticToolDefinition` (pola beku
  yang sama seperti `ARTIFACT_TOOL_DEFINITIONS`).
- Nama: `view_site_page`. Input: `siteId` (string 1–120),
  `version` (int ≥ 1, opsional — default versi stabil saat dipanggil),
  `question` (string ≤ 500, opsional — diteruskan sebagai konteks,
  mis. "nilai hero section").
- Deskripsi tool menegaskan dua hal: (1) selalu kembalikan cuplikan teks +
  provenance, (2) `imageId` hanya berguna via image block (vision) atau
  `view_image` (text-only) — cegah model text-only mengira ia bisa "membuka"
  imageId mentah.
- Update `PINNED_ARTIFACT_INSTRUCTION` (`artifacts.ts:98`): setelah
  `get_artifact`, untuk menilai isi/tampilan site panggil `view_site_page`;
  jangan minta screenshot ke user.

### 3.2 Service — `apps/api/src/modules/static-sites/viewing.ts` (baru)

- `resolveSiteVersion({userId, sessionProjectId, siteId, version?})`:
  scope-check via `getScopedSite` yang sudah ada; tanpa version → pakai versi
  stabil saat itu; kembalikan `{siteId, version}` konkret atau throw
  not-found (pesan sama gaya dengan `get_artifact`: "…not in the current scope").
- `extractSiteExcerpt({siteId, version, maxChars=6000})`: baca `index.html`
  versi tersebut dari disk (reuse resolusi path `download.ts`), buang
  `<script>/<style>`, strip tag, collapse whitespace. Tanpa dependensi baru
  (±20 baris, pola hand-roll — YAGNI atas `html-to-text`). Sertakan
  `{title, headings[], truncated}` bila murah didapat dari parse yang sama.
- `captureSiteScreenshot({siteId, version})`:
  - Cache dulu: mapping `(siteId, version) → {imageId, capturedAt, viewport,
    fullPage, truncated}` tersimpan sebagai field opsional `screenshots` di
    `SiteManifest` (`service.ts:19`) — read/write manifest adalah passthrough
    JSON (`{...parsed}`), jadi tanpa migrasi: manifest lama otomatis
    `screenshots: undefined`.
  - Cache hit → kembalikan langsung, tanpa menyalakan browser.
  - Cache miss → single-flight per `(siteId, version)` (panggilan konkuren
    gabung ke satu capture), lalu Playwright: `chromium.launch()` →
    viewport 1440×900 → `goto(previewUrl lokal)` dengan auto-wait →
    `screenshot({fullPage: true})` dengan cap tinggi 16.000px
    (`truncated: true` + `capturedHeight` bila kepotong).
  - PNG → `getImageStore().saveGeneratedImage({…, mediaType: "image/png",
    modelId: "site-screenshot", source: "site-screenshot",
    caption: "Screenshot site {label} v{n}", width, height})` → `imageId`.
  - Selalu `browser.close()` di `finally` (anti zombie-process).
- Batas operasional: maks 2 browser konkuren (antrean FIFO), timeout
  navigasi 15 dtk + total 30 dtk, PNG ≤ 5 MB (downscale bila perlu —
  vision hanya butuh keterbacaan, bukan piksel penuh).
- Dependensi: `playwright-core` (bukan `playwright` penuh — hindari download
  3 browser). Provisi browser via channel Chrome sistem bila ada, else
  `chromium` headless; didokumentasikan di README/API (env + langkah
  install). Tanpa layanan screenshot eksternal (site localhost tidak
  terjangkau publik).

### 3.3 Wiring + recipe — `apps/api/src/modules/chat/build-run-input.ts`

- Daftarkan `...SITE_VIEW_TOOL_DEFINITIONS` di array `toolDefinitions`
  (posisi: tepat setelah `ARTIFACT_TOOL_DEFINITIONS`, sebelum report tools)
  dan implementasi live-nya di sebelah `createArtifactTools` (≈ baris 1390)
  dengan deps `{getExcerpt, capture}` dari service 3.2 — agar **urutan live
  tetap cermin frozen surface** (komentar penanda yang sudah ada).
- Bump `CHAT_AGENT_RECIPE_VERSION` 5 → 6 (`run-recipe.ts:6`).
- Tidak ada perubahan pada `view_image`, `attach-prompt-images`, memory
  sanitizer, atau pola `includeImageBytes` — semuanya reuse.

### 3.4 `get_artifact` site — sertakan cuplikan (`service.ts:226`)

- Response site tambah `excerpt` (reuse 3.2; dibatasi ±2.000 char di path
  ini agar ringan) + `stableVersion`. Alasan: agent yang hanya butuh konteks
  cepat tidak perlu memanggil tool kedua.
- Deskripsi `get_artifact` tidak diubah (tetap "full detail" — sekarang
  benar-benar penuh).

### 3.5 Narasi ke user — tanpa template

- Tidak ada tipe event progress baru, tidak ada string canned. Agent
  bernarasi bebas lewat teksnya sendiri sebelum/sesudah tool call
  ("Saya buka dulu sitenya…").
- Selama capture berjalan, UI yang tampil = pola existing: baris aktivitas
  tool + elapsed time (`toolWaitProgress`). Tidak ada pekerjaan platform.

### 3.6 Chip di bubble assistant — `chat-message-row.tsx` + reuse

- Cabang text-part: terapkan `splitPinnedText` yang sudah ada untuk role
  `assistant` juga (saat ini hanya `user`): refs → `PinnedArtifactChips`
  read-only + `MarkdownBody` berisi teks bersih; pin-only → chips saja.
- Tidak menyentuh teks mentah untuk edit/resubmit/copy (render-only).

## 4. Alur data per jenis model

- Vision: `view_site_page` → `{excerpt, imageId, provenance}` sebagai JSON
  + PNG diantrekan ke **pending vision buffer** run (`parentVisionImages`,
  mekanisme yang sama dengan web_search images) sehingga turn model
  berikutnya menerima image block native dalam user message. Berlaku untuk
  SEMUA provider API (chat completions maupun responses). Tool TIDAK
  mengembalikan file part: pada chat completions file part direduksi
  framework menjadi placeholder `[file:…]`, dan toolCallId yang dipakai
  ulang antar call bisa bertabrakan. `view_image` TIDAK dipanggil.
- Text-only: hasil yang sama tetapi tanpa antrean bytes → model memanggil
  `view_image({imageId})` → helper vision mengembalikan deskripsi teks.
  Satu-satunya pintu visual model non-vision, sesuai arahan.

## 5. Stale & provenance (by design, bukan deteksi)

- Screenshot terikat `(siteId, version)` konkret; version immutable → tidak
  pernah basi. "Perubahan" = version baru = objek cache berbeda.
- Setiap hasil mencantumkan `{siteId, version, imageId, capturedAt,
  viewport, fullPage, truncated}` sehingga model dan log bisa diaudit.
- Resolve "latest" selalu dievaluasi saat tool dipanggil, bukan saat pin
  dibuat.

## 6. Error handling

- Site/version out-of-scope → throw not-found (gaya pesan existing).
- Browser gagal launch / timeout / PNG korup → throw retryable error
  (`retryable: true`, tanpa imageId) + cuplikan teks tetap dikembalikan bila
  ada — agent tetap bisa menjawab parsial dan jujur bilang screenshot gagal.
- Versi non-ready (building/failed) atau tanpa `index.html` → kembalikan
  metadata + status, tanpa capture; pesan eksplisit "belum ada yang bisa
  dilihat".

## 7. Testing

- Unit (tanpa browser): excerpt strip vectors, cache-key + resolve-version,
  kontrak definisi tool (paritas static/live), chip assistant render statis.
- Integrasi capture: browser di-inject (pola `fetchFn`-style); skip bila
  Chromium tidak tersedia — tidak boleh menggagalkan CI tanpanya.
- E2E real-LLM (muse-spark): pin site → "review desainnya" → agent memanggil
  `view_site_page`, jawaban merujuk konten visual, tidak meminta screenshot.
  Satu varian text-only (deepseek) memastikan jalur `view_image` terpanggil.
- Regresi: suite artifacts/composer/chat platform + agent + api tetap hijau;
  tsc/lint bersih.

## 8. Rollout

- Satu PR di branch aktif: service + wiring + recipe 6 + definisi tool +
  chip assistant + test. Tanpa migrasi data (field manifest opsional).
- Verifikasi pra-claim (wajib): unit + integrasi + E2E real-LLM +
  screenshot bubble assistant.

# Spec: Live Site Browsing (fase 2) — `browse_site` + live frame + cursor sintetik

Tanggal: 2026-09-26. Status: draft untuk review. Scope: sesi browse agentic dengan
tampilan live untuk user. Melanjutkan fase 1 (`view_site_page`) tanpa mengubahnya.

Fakta riset yang mendasari spec ini:
- Playwright `page.screencast.start({ size, quality, onFrame })` (v1.59+) mengalirkan
  frame JPEG + ukuran viewport; sudah tersedia di `playwright-core@1.63` yang dipakai repo.
- `screencast.showActions({ cursor: "pointer" })` (cursor sejak v1.61) menggambar panah
  cursor animasi + ripple klik + label aksi di dalam frame. Diverifikasi lewat spike lokal:
  frame `onFrame` memuat cursor, ripple, dan label ("Mouse move") — cursor sintetik tidak
  perlu digambar sendiri.

## 1. Tujuan

User dapat menonton agent "melihat" site secara live (frame bergerak di UI) sambil agent
melakukan aksi nyata (scroll, klik) pada site statis miliknya, dengan cursor + label aksi
yang terlihat di frame. Agent tetap menerima screenshot per aksi untuk penalaran (vision
bytes / `view_image` untuk model text-only).

Non-tujuan: mengontrol browser user (bukan CDP takeover), multi-halaman/back/forward,
form typing, download, screenshot layar penuh, WebSocket realtime 10fps, sesi persisten
lintas run.

## 2. Arsitektur

```
Agent turn ──▶ browse_site(action=open|scroll|click|snapshot|close)
                 ├─ Sesi browser hidup di worker (1 per chat): playwright page + screencast
                 │    ├─ showActions({cursor:"pointer"}) → cursor+label ikut di frame
                 │    ├─ onFrame (rate CDP) → throttle ≥300ms → Redis `site-live:{sessionId}`
                 │    │                                        (base64 JPEG, TTL 30 dtk)
                 │    └─ aksi: scroll/click → screenshot → image store → imageId
                 │         ├─ model vision  → bytes via pending vision buffer
                 │         └─ text-only     → view_image(imageId)
                 └─ event kecil `siteLiveView` (started/stopped) ──▶ resumable stream ──▶ UI
UI kartu live ── poll `GET /api/sites/live/:sessionId/frame` (auth) ──▶ tampilkan JPEG
```

Keputusan kunci:
- **Frame tidak lewat resumable stream.** Stream itu tanpa trimming (EVAL per-event, TTL 6 jam);
  frame ratusan per menit akan membengkakkan Redis run. Kanal terpisah: key ephemeral
  TTL pendek + endpoint poll.
- **Event kecil tetap lewat pipeline client-data yang ada** (started/stopped) supaya UI tahu
  kapan kartu muncul/hilang. Wajib didaftarkan juga di validator store
  (`validDefaultData` + `DEFAULT_DATA_SCHEMAS`) — pelajaran dari bug `artifactFocus`.
- **Tool baru, bukan mengubah `view_site_page`.** Frozen surface bertambah 1 tool; recipe
  bump 6 → 7.

## 3. Komponen

### 3.1 Tool `browse_site` — `packages/agent/src/tools/site-browsing.ts` (baru)

- `BROWSE_SITE_TOOL_DEFINITIONS` via `createStaticToolDefinition` (pola beku sama).
- Input:
  - `action`: `"open" | "scroll" | "click" | "snapshot" | "close"`.
  - `siteId` (wajib untuk `open`: string 1–120; aksi lain mengabaikan/menerima opsional untuk audit).
  - `version?` (int ≥ 1, saat open).
  - `direction?`: `"up" | "down" | "top" | "bottom"` (untuk scroll; default `down`).
  - `pixels?`: int 100–4000 (untuk scroll; default satu viewport).
  - `selector?` / `text?` (untuk click; tepat satu; `text` dicocokkan via
    `getByText(..., { exact:false }).first()`).
  - `question?` (≤500, echoed sebagai `focus`).
- Output JSON (satu bentuk untuk semua aksi):
  `{ action, siteId, version, title, url, scrollY, step, maxSteps, imageId, capturedAt,
     viewport, fullPage:false, truncated, mediaType, focus, captureError, retryable }`.
  `imageId` diisi untuk `open|scroll|click|snapshot`; kosong untuk `close`.
- Deskripsi tool: sesi terikat chat (agent tidak mengelola session id); `view_site_page`
  tetap untuk "lihat sekali"; `browse_site` untuk scroll/klik + user menonton live.
- Live factory `createBrowseSiteTools(deps)` tinggal di packages/agent (pola `createViewSitePageTools`),
  deps: `browse(input) => Promise<BrowseSiteResult>`, `pushVisionImage?`, `includeImageBytes?`,
  `onFocus?`. Pengiriman gambar mengikuti pola fase 1 (JSON-only + pending vision buffer).
- `PINNED_ARTIFACT_INSTRUCTION` ditambah kalimat: gunakan `browse_site` bila perlu
  scroll/klik (user melihat live), `view_site_page` cukup untuk sekilas.

### 3.2 Sesi live — `apps/api/src/modules/static-sites/live-session.ts` (baru)

- Registry in-memory worker: `Map<string /* userId:sessionId */, LiveSession>`.
- `LiveSession`: `{ userId, sessionId, siteId, version, browser, page, screencast, actions,
  lastActionAt, openedAt, flushTimer?, closed }`.
- `openLiveSession({ userId, sessionId, siteId, version, label, deps })`:
  - Idempotent: bila sudah ada sesi hidup untuk key yang sama → tutup dulu (close bersih).
  - Ambil slot browser dari semaphore global yang sama dengan capture (maks 2; live memegang
    1 slot selama sesi) → cegah >2 Chromium.
  - Launch `chromium` (channel chrome + fallback, reuse `launchChromium`), viewport 1440×900.
  - Pasang **navigation guard**: `page.route("**/*")` → abort bila `request.isNavigationRequest()
    && frame === mainFrame && url origin !== getApiOrigin()`; selain itu lanjut. Download
    disabled (`acceptDownloads:false`), dialog auto-dismiss (`page.on("dialog", d => d.dismiss())`).
  - `goto(getApiOrigin() + previewPath, { waitUntil:"domcontentloaded", timeout:15s })`.
  - `screencast.start({ size:{width:1024,height:640}, quality:60, onFrame })` +
    `showActions({ cursor:"pointer", duration:700 })`.
  - `onFrame`: simpan `latestFrame` (Buffer) + tulis ke Redis `site-live:{sessionId}`
    (base64) dengan throttle ≥300 ms dan `PX 30000`; tulis juga frame terakhir saat stop.
  - Kembalikan `LiveSession`.
- `getLiveSession(userId, sessionId)`; `runLiveAction(...)`; `closeLiveSession(...)`:
  stop screencast + dispose actions + `page.close` + `browser.close` + lepas slot + hapus
  Redis key. Selalu `finally`.
- **TTL idle 90 detik**: timer interval per sesi (atau lazy check pada aksi berikut);
  tutup otomatis + publish event `stopped` reason `"idle"`.
- Batas: **maks 12 aksi** per sesi (step counter); melampaui → `close` otomatis + error
  eksplisit ke agent. Maks **1 sesi live** per chat; sesi lain ditutup saat open baru.
- Cleanup: fungsi `closeSessionLiveViews(sessionId)` dipanggil dari `ChatRunInput.cleanup`
  (build-run-input) sehingga run berakhir/abort selalu menutup browser; juga pada
  `cancelCurrentAttempt` (abortSignal) via cleanup yang sama.

Aksi (semua mengembalikan screenshot baru kecuali `close`):
- `open`: sudah punya screenshot pertama (setelah goto).
- `scroll`: `page.mouse.wheel(0, dy)` (up = negatif; top/bottom = scrollTo) lalu tunggu
  `scrollend`/200 ms, `evaluate(scrollY)`.
- `click`: locator dari `selector` atau `getByText(text).first()`; `scrollIntoViewIfNeeded`
  + `locator.click({ timeout:5000 })`; screenshot setelahnya.
- `snapshot`: screenshot ulang tanpa aksi.
- `close`: tutup sesi; output tanpa imageId.

Screenshot per aksi memakai jalur fase 1: PNG fullPage=false (viewport, karena sesi
interaktif) → fallback JPEG bila >5 MB; simpan ke image store dengan caption
`"Browser step {n} · {label}"`, `source:"site-browse"`; model vision menerima bytes via
pending vision buffer, text-only via `view_image`.

### 3.3 Event `siteLiveView` — client-events + client-data + validator

- Server (`apps/api/src/modules/chat/client-events.ts`): data `{ state: "started"|"stopped",
  siteId, label?, reason? }` (`reason`: `"closed"|"idle"|"limit"|"navigation"|"error"`);
  app-event `{ type: "site_live_view", ... }`; daftarkan di `ChatDataMap`, `ChatDataSchemas`,
  `ChatAppEvent`, `mapChatAppEvent`.
- Validator store (`apps/api/src/lib/resumable-stream-store.ts`): tambah `siteLiveView` ke
  `validDefaultData` + `DEFAULT_DATA_SCHEMAS` (caps: siteId ≤120, label ≤200, enum state/reason).
- Producer: `publishSiteLiveView(input)` — pola `publishArtifactFocus` (baca
  `ACTIVE_RUN_KEY`, append ke stream; fire-and-forget dengan warn).
- Platform (`apps/platform/src/lib/chat/client-data.ts`): mirror type + parser + schema.
- `isRenderablePart` (chat-message-row): `siteLiveView` tidak dirender sebagai baris transkrip.

### 3.4 Endpoint frame — `apps/api/src/modules/static-sites/download.ts`

- `GET /api/sites/live/:sessionId/frame` + `requireUser`:
  - Validasi `sessionId` (SAFE_ID), cek ownership via `prisma.chatSession.findFirst({ id, userId })`;
    bukan pemilik / tidak ada → 404 JSON.
  - Baca Redis `site-live:{sessionId}`; kosong → **204** (tanpa body).
  - Ada → `c.body(jpegBytes, 200, { "content-type":"image/jpeg", "cache-control":"no-store" })`.
- OpenAPI: dokumentasikan route (200 binary/204/401/404).

### 3.5 UI kartu live — `apps/platform/src/components/sites/site-live-view.tsx` (baru)

- Muncul di dock atas composer (slot yang sama dengan banner `artifactFocus`, max-w 760),
  hanya saat event `siteLiveView.state === "started"`; `stopped` → animasi keluar + unmount.
- Hook `useLiveSiteFrame(sessionId, active)`: poll `GET /api/sites/live/:sessionId/frame`
  via `apiFetch` (credentials) tiap 300–400 ms; 204 → pertahankan frame lama; blob →
  objectURL baru + revoke lama; berhenti saat `active=false` (unmount/replace).
- Kartu: header `Live · {label}` + pulsa status + tombol dismiss; area frame rasio 16:10
  (`object-contain`, background gelap); label aksi sudah tercetak di frame oleh Playwright.
- Dismiss hanya menyembunyikan kartu (sesi browse tetap berjalan); kartu muncul lagi pada
  event `started` berikutnya.
- A11y: `role="status"`, `aria-label="Live site view"`, alt frame deskriptif.

### 3.6 Wiring chat-session

- `handleChatEvent`: case `siteLiveView` → state `liveSiteView` (pola `artifactFocus`);
  render kartu sebelum `<ChatComposer>`.
- `activeSessionId` sudah tersedia di `chat-session.tsx`; kartu menerimanya untuk polling.

## 4. Alur per jenis model

- Vision: tiap aksi mengembalikan `imageId`; bytes diantrekan ke pending vision buffer
  (JSON-only tool result), jadi model "melihat" hasil scroll/klik pada turn berikutnya.
- Text-only: `imageId` dioper ke `view_image` (deskripsi via vision helper).
- Keduanya sama-sama memicu frame live ke UI (tidak tergantung kapabilitas model).

## 5. Lifecycle & stale

- Sesi terikat chat session + user; auto-close saat: aksi `close`, idle 90 dtk, limit 12 aksi,
  navigasi diblokir berturut-turut, run selesai/abort (cleanup), atau open baru di chat yang sama.
- Tidak ada state persisten: worker restart = sesi hilang; aksi berikutnya mengembalikan error
  eksplisit "session not open" dan agent bisa `open` lagi.
- Frame Redis ephemeral TTL 30 dtk; endpoint 204 setelah sesi tutup → UI berhenti alami.

## 6. Error handling

- `open` gagal (launch/nav/timeout) → error retryable, tanpa sesi menggantung (finally tutup).
- Aksi saat sesi tidak ada → error `"Browse session is not open. Call browse_site open first."`
- `click` target tidak ketemu → error eksplisit (selector/teks) + screenshot kondisi saat ini
  tetap dikembalikan (agent bisa mengoreksi).
- Screenshot gagal → `captureError` + `retryable`, sesi tetap hidup.
- Batas/limit → `close` otomatis + output menyertakan `error` dan `retryable:false`.
- Frame endpoint: 401 unauthenticated, 404 bukan pemilik, 204 tidak ada frame.

## 7. Keamanan

- Hanya site registry scope user (resolve + ownership fase 1 dipakai ulang).
- Navigation guard top-level ke luar origin API di-abort; subresource dibiarkan (site statis
  boleh load asset lokal; tidak ada fetch eksternal di dist).
- Tanpa evaluasi JS dari model; aksi terbatas whitelist; tanpa `type`/form submit (YAGNI).
- Tidak ada `r2Key`/Redis value yang bocor ke browser; frame endpoint hanya JPEG.
- Satu sesi/browser per chat + semaphore global 2 → batas resource keras.

## 8. Testing

- **Unit (agent)**: skema `browse_site` (aksi valid, selector XOR text, batas pixels),
  factory (JSON-only + pushVisionImage + focus), instruksi pin memuat `browse_site`.
- **Unit/API**:
  - Registry: open idempotent (tutup sesi lama), get, close melepas slot + Redis key,
    idle TTL menutup, limit 12 aksi, cleanup run menutup semua.
  - Throttle writer: ≥300 ms antar tulisan; frame terakhir ditulis saat stop (fake redis).
  - Navigation guard predicate: origin API lolos, eksternal ditolak, non-navigation lolos
    (fake route/request).
  - Frame endpoint: 404 bukan pemilik, 204 kosong, 200 JPEG + header no-store.
  - Event: round-trip `siteLiveView` lewat validator store (pola test `artifactFocus`).
- **DOM**: kartu live muncul saat `started` (mock apiFetch mengembalikan blob), render `<img>`,
  hide saat `stopped`, dismiss menyembunyikan tanpa mematikan polling? (dismiss = unmount).
- **E2E real-LLM (muse-spark, reasoning high)**:
  1. Agent membangun site 2 seksi + nav link (anchor).
  2. Sesi baru: pin site → "browse: scroll ke bawah, klik link nav, lalu jelaskan isi seksi
     tujuan" → assert tool call `browse_site` (`open`, `scroll`, `click`, `close`),
     frame endpoint pernah mengembalikan 200 (JPEG) selama run, kartu live tampil di UI
     (elemen `role=status` + `<img>` blob), jawaban menyebut teks seksi tujuan.
  3. Negative: navigasi eksternal diblokir (unit-level cukup; E2E opsional bila site dibuat
     memuat link eksternal).
- **Verifikasi manual via Playwright MCP** untuk tampilan kartu + frame bergerak.
- Regression: suite agent/api/platform penuh; recipe v7 update literal test.

## 9. Perubahan lintas paket (checklist implementasi)

- `packages/agent`: tool baru + instruksi + test; export index.
- `apps/api`: live-session, wiring tool di `build-run-input` (frozen surface: posisi tepat
  setelah `SITE_VIEW_TOOL_DEFINITIONS`), event + validator + publisher, endpoint frame,
  cleanup hook, recipe **v7** (+ update literal test: run-recipe, run-recipe-behavior,
  site-build-wiring, interaction-store/redis, interaction-resume, run-queue, run-worker,
  anvia-v1-regression; cek juga platform regression bila ada).
- `apps/platform`: client-data mirror, kartu live + hook, wiring chat-session, OpenAPI client
  tidak berubah.
- `README.md`: bagian live browsing + env/limit.
- Tanpa migrasi DB.

## 10. Batas & konstanta

| Konstanta | Nilai |
| --- | --- |
| Frame size / quality | ≤1024×640, JPEG q60 |
| Throttle tulis frame | ≥300 ms; TTL Redis 30 dtk |
| Viewport sesi | 1440×900 |
| Idle TTL sesi | 90 dtk |
| Maks aksi per sesi | 12 |
| Sesi live per chat | 1 |
| Semaphore browser | 2 (capture + live berbagi) |
| Nav timeout / aksi | 15 dtk / 5 dtk per click |

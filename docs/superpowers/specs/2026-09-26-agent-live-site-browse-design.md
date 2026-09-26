# Spec: Agent Live Site Browse (fase 2) — sesi browse + live frame + cursor

Tanggal: 2026-09-26. Status: draft untuk review. Branch:
`feat/agent-live-view-hardening`. Melanjutkan Spec fase 1
(`docs/superpowers/specs/2026-09-25-site-viewing-design.md`) yang sudah merge.

## 1. Tujuan

User bisa **menonton agent menelusuri site** secara near-realtime di chat:
agent scroll/klik beberapa langkah, UI menampilkan frame browser yang terus
diperbarui, lengkap dengan cursor + animasi klik + label aksi. Agent tetap
menerima screenshot per langkah (vision / `view_image`) sehingga keputusan
berikutnya berbasis isi halaman, bukan tebakan.

Non-tujuan: form typing/upload, multi-tab, takeover manusia, rekaman video
permanen, Docker/`@anvia/browser` (localhost ditolak), iframe-replay perintah
(tidak robust; industri memakai screencast).

## 2. Riset yang mengunci desain

- **Playwright 1.59+ punya `page.screencast` first-class**; 1.63 terpasang.
  `start({ size, quality, onFrame })` mengirim **JPEG** per frame.
- **`screencast.showActions({ cursor: "pointer" })`** menggambar cursor
  animasi + highlight elemen + label aksi, dan **dekorasinya ikut ke frame
  `onFrame`** — diverifikasi lewat spike lokal (frame menunjukkan cursor,
  ripple klik, label "Mouse move").
- Resumable stream kita **tanpa trimming** (1 EVAL/frame, TTL 6 jam) → frame
  tidak boleh lewat jalur itu.
- Hook teardown per-run sudah ada (`ChatRunInput.cleanup`, dipanggil di
  `finally` run-worker) → tempat menutup sesi browse.
- Validator `resumable-stream-store` harus didaftarkan untuk setiap tipe
  client-data baru (pelajaran dari bug `artifactFocus`).

## 3. Arsitektur

```
Agent run (worker)
  browse_site(open) ─▶ BrowseSessionRegistry ─▶ Chromium page (localhost preview)
                          │  screencast.onFrame (throttle 300ms)
                          │      └─▶ Redis SET site-live:{sessionId} (JPEG, TTL 30s)
                          │  showActions({cursor:"pointer"})
                          └─▶ publishSiteLiveView(started/stopped) ─▶ resumable stream
                                (event kecil, UI tahu kapan polling)
UI
  GET /api/sites/live/:sessionId/frame (auth+ownership) ─▶ JPEG terbaru / 204
  Kartu live di atas composer, poll ~3 fps, fetch blob terautentikasi
```

Satu browser dipakai bersama capture fase 1 lewat semaphore yang sama
(browse memegang 1 slot selama sesi hidup).

## 4. Komponen

### 4.1 Tool statis `browse_site` — `packages/agent/src/tools/site-browse.ts` (baru)

- Skema input:
  `{ siteId (1–120), version? (int ≥1), action: "open"|"scroll"|"click"|"snapshot"|"close",
     target? (≤200; CSS selector ATAU teks link), scrollY? (int ≥0) }`
- Deskripsi menegaskan: panggil `open` dulu; tiap aksi mengembalikan screenshot
  + judul/URL + daftar link; jangan menebak isi halaman.
- `BROWSE_SITE_TOOL_DEFINITIONS` + `createBrowseSiteTools(deps)` (pola sama dengan
  `createViewSitePageTools`): deps `{ run, onFocus? }`; output JSON
  `{ siteId, version, action, title, url, step, imageId, imageBytesIncluded,
     links: [{text, selector}], truncated }`.
- Screenshot per aksi: disimpan ke image store (`source: "site-browse"`,
  caption `Browse {label} v{n} step {k}`) dan diantrekan ke pending vision
  buffer untuk model vision (JSON-only tool output; `imageBytesIncluded` jujur),
  `view_image(imageId)` untuk text-only.

### 4.2 `BrowseSessionRegistry` — `apps/api/src/modules/static-sites/browse.ts` (baru)

- Key `(userId, sessionId)`; maksimum **1 sesi per chat**; aksi maksimum **12**
  per sesi; idle **90 detik** auto-close (lazy check di tiap panggilan +
  interval sweeper `unref()` di worker, dimatikan saat shutdown).
- `open`: resolve versi site (reuse `resolveSiteVersion`), scope-check,
  launch/reuse Chromium, viewport 1440×900, `goto(getApiOrigin()+previewPath)`,
  `showActions({cursor:"pointer", duration: 800})`, `screencast.start(...)`.
- Aksi:
  - `scroll`: `mouse.wheel` / `evaluate(scrollTo)` ke `scrollY` (default +1 layar);
  - `click`: `target` diawali `css=` → `locator(target)`; selain itu
    `getByRole("link"|"button"|"heading", { name })` → fallback `getByText(...).first()`;
  - `snapshot`: screenshot tanpa aksi;
  - `close`: stop screencast + dispose actions + tutup page/browser + hapus
    Redis key + publish `stopped`.
- Screenshot per aksi: `page.screenshot({ fullPage: false })` (viewport; live
  view yang penting, bukan stitched) dengan cap 5 MB, fallback JPEG q70.
- Link summary: `page.locator("a").all()` → `{text, selector}` maks 20
  (membantu model memilih target klik).
- **Guard navigasi**: `page.route("**/*", ...)` — abort request navigasi
  top-level yang origin-nya ≠ `getApiOrigin()`; download dibatalkan
  (`page.on("download", d => d.cancel())`); `dialog` auto-dismiss.
- Error: sesi hilang/idle → `"Browser session is closed — call browse_site with
  action 'open' again."`; klik tidak ketemu → error eksplisit + link terdekat;
  navigasi diblokir → pesan eksplisit.
- Cleanup: sesi ditutup oleh aksi `close`, idle sweeper, dan **hook cleanup
  run** (perpanjang `closeUserEnhancements`/cleanup map untuk sesi browse
  milik sessionId tersebut). Semua jalur `finally` menutup browser.

### 4.3 Live frame (kanal ephemeral)

- `onFrame` → throttle ≥300ms: simpan hanya frame terakhir, tulis
  `SET site-live:{sessionId} <jpeg> PX 30000` (cap frame 150 KB, skip bila
  lebih besar). Fire-and-forget + warn saat gagal; tidak pernah memblok aksi.
- `GET /api/sites/live/:sessionId/frame` (requireUser): verifikasi sesi milik
  user (`chatSession.findFirst`), `GET buffer site-live:{sessionId}` →
  `image/jpeg`, `cache-control: no-store`; tidak ada → `204`.
- Frame key dihapus saat sesi ditutup.

### 4.4 Event `siteLiveView`

- Client-data baru `{ siteId, label?, state: "started"|"stopped" }`.
- Wajib didaftarkan di: `client-events.ts` (schema + map + union),
  `client-data.ts` platform (parser + schema), **dan validator
  `resumable-stream-store` (`validDefaultData` + `DEFAULT_DATA_SCHEMAS`)**.
- Publisher `publishSiteLiveView` mengikuti pola `artifactFocus`
  (baca `ACTIVE_RUN_KEY`, append ke stream aktif, warn-only saat gagal).
- UI: `chat-session.tsx` menyimpan state `siteLiveView`; kartu muncul saat
  `started`, hilang saat `stopped`; komponen di-render di dock yang sama
  dengan banner artifactFocus (di atas composer, `max-w-[760px]`).

### 4.5 UI — `apps/platform/src/components/sites/site-live-view.tsx` (baru)

- Kartu: judul `Live · {label ?? siteId}`, dot pulse, frame 16:9
  (`aspect-video`, `object-contain`, latar gelap), tombol **Dismiss**
  (menyembunyikan kartu; sesi tetap berjalan), indikator step?
- Frame: hook `useSiteLiveFrame(sessionId, active)` — poll
  `apiFetch(frame endpoint)` tiap ~350ms → `blob` → `URL.createObjectURL`,
  revoke object URL sebelumnya; 204 → pertahankan frame terakhir; error →
  pesan kecil + retry otomatis pada poll berikutnya.
- A11y: `region aria-label="Agent live view"`, `aria-live="polite"` untuk
  status (bukan frame).

### 4.6 Wiring recipe + freeze

- Daftarkan `BROWSE_SITE_TOOL_DEFINITIONS` di frozen array (setelah
  `SITE_VIEW_TOOL_DEFINITIONS`) + live tools setelah `createViewSitePageTools`.
- Bump `CHAT_AGENT_RECIPE_VERSION` 6 → 7 dan perbarui semua literal versi di
  test (pola yang sama saat bump 5 → 6).
- OpenAPI: dokumentasikan endpoint frame.

## 5. Alur data per jenis model

- Vision: `browse_site` → JSON + PNG viewport diantrekan ke pending vision
  buffer (image block native), persis mekanisme `view_site_page`.
- Text-only: JSON + `imageId` → `view_image(imageId)` → deskripsi.
- Live frame **bukan** input model; ia hanya UX untuk user.

## 6. Batas & keamanan

- Hanya origin API (`getApiOrigin()`) yang boleh dinavigasi; link eksternal
  diblokir dan hasilnya dilaporkan ke model.
- Satu sesi browse per chat; aksi ≤12; idle 90 dtk; frame TTL 30 dtk; cap
  frame 150 KB; PNG aksi ≤5 MB.
- Tanpa form typing/upload; tanpa evaluate JS dari model; selector dari model
  hanya boleh CSS teks (tidak ada `page.evaluate` yang diekspos).
- Semua penguncian: scope site diverifikasi ulang tiap aksi (sesi menyimpan
  userId + siteId dan memvalidasi kecocokan; panggilan dengan siteId lain
  dianggap salah dan diminta `open` baru).

## 7. Error handling

- Sesi mati/idle → pesan eksplisit + minta `open` ulang (state di UI
  di-reset lewat event `stopped` saat sweeper menutup).
- Navigasi/klik gagal → error eksplisit, langkah tidak dihitung (step hanya
  bertambah saat aksi berhasil).
- Frame/Redis gagal → warn, browse tetap jalan.
- Browser crash → registry membuang sesi, tool error retryable, UI stopped.

## 8. Testing

- **Unit (tanpa browser):** skema tool + kontrak nama; registry (TTL idle,
  maks aksi, satu sesi per chat, guard siteId berbeda); throttle frame
  (≥300ms, cap ukuran, latest-wins); guard navigasi (origin lain di-abort);
  parser/validator event `siteLiveView` (server + platform + store).
- **API:** endpoint frame — 401 tanpa auth, 204 tanpa sesi, 200 JPEG saat ada,
  verifikasi ownership sesi (user lain 404), `no-store`.
- **DOM:** kartu live muncul dari event `started`, poll memanggil endpoint
  (mock), menampilkan `<img>` blob, hide saat `stopped`/dismiss, tetap frame
  terakhir saat 204.
- **E2E real-LLM (muse-spark-1.3-contributor, high):** build site 2 seksi +
  link nav, pindah sesi, pin, minta agent menelusuri (scroll ke seksi 2, klik
  link) dan jelaskan isinya; asert: tool `browse_site` terpanggil ≥3 aksi,
  endpoint frame mengembalikan JPEG selama sesi hidup, kartu live tampil
  (screenshot evidence), jawaban menyebut teks seksi tujuan, tidak ada token
  mentah.
- **Verifikasi manual Playwright MCP** untuk panel live (polling + dismiss).
- Suite regresi: agent/api/platform + tsc bersih (di luar kegagalan
  pre-existing yang sudah tercatat).

## 9. Rollout

- Satu PR di branch `feat/agent-live-view-hardening` sepaket dengan batch
  bounded yang sudah selesai. Tanpa migrasi DB. Env baru: tidak ada
  (`SITE_BROWSE_*` opsional hanya bila perlu saat implementasi, didokumentasikan
  di README).
- Verifikasi pra-claim: unit + API + DOM + E2E real-LLM + screenshot evidence.

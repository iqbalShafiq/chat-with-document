# Spec: Agent Live Site Browse (fase 2) — `browse_site` + live frames + action cursor

Tanggal: 2026-09-26. Status: draft untuk review. Scope: satu sesi browse
agentic dengan live view di chat. Live screencast + cursor Playwright
(cursor option tersedia sejak Playwright 1.61; terverifikasi masuk frame
`onFrame` lewat spike di repo ini).

## 1. Tujuan

User dapat "nonton" agent melihat site: agent bisa scroll dan klik di
halaman site pinned, sementara frame browser live (termasuk cursor + label
aksi bawaan Playwright) tampil di kartu di atas composer. Berlaku untuk
model vision (screenshot per aksi dikirim sebagai bytes) maupun text-only
(melalui `view_image`). Token mentah tetap tidak pernah tampil.

Non-tujuan: browser multi-tab, form typing, login/auth, download file,
kontrol manual user (takeover), rekaman video tersimpan, situs eksternal
(hanya preview site lokal dari registry scope).

## 2. Arsitektur

```
Agent turn ──▶ browse_site({action})
                 ├─ open: launch browser (slot semaphore) → goto preview
                 │        → screencast.start(onFrame) + showActions(cursor)
                 │        → event siteLiveView(started) → Redis {site-live:<session>}
                 ├─ scroll|click|snapshot: aksi Playwright → screenshot
                 │        → image store → imageId (+ vision buffer)
                 └─ close | idle TTL | run cleanup:
                          screencast.stop + browser.close
                          → event siteLiveView(stopped) → Redis key deleted
                                    │
UI ◀── GET /api/sites/live/:sessionId/frame (auth+ownership) ◀── Redis
        poll ~3fps, tampilkan di kartu live
```

Proses: tool dieksekusi di **worker** (tempat agent berjalan). Frame harus
melewati Redis karena API dan worker adalah proses terpisah. Frame TIDAK
lewat resumable stream (tanpa trimming; 1 EVAL/frame; TTL 6 jam) — hanya
event kecil `siteLiveView` yang lewat stream.

## 3. Komponen

### 3.1 Tool `browse_site` — `packages/agent/src/tools/site-viewing.ts`

Tambahan pada `SITE_VIEW_TOOL_DEFINITIONS` (permukaan beku):

```ts
browse_site({
  siteId, version?,
  action: "open" | "scroll" | "click" | "snapshot" | "close",
  selector?,  // click via CSS
  text?,      // click via accessible text (exact=false, first match)
  to?,        // scroll: "top" | "bottom"
})
```

- `open` wajib aksi pertama; memulai sesi + live view.
- `scroll` default turun satu viewport; `to: "top"|"bottom"` untuk lompat.
- `click` butuh tepat satu dari `selector`/`text`.
- Hasil JSON per aksi: `{ siteId, version, action, title, url, imageId,
  blocked?, note?, actionsUsed, actionsRemaining, sessionState }`.
- `imageId` mengikuti pola `view_site_page`: vektor vision menerima bytes
  inline; text-only memakai `view_image(imageId)`.
- Deskripsi tool menegaskan: satu aksi per panggilan, panggil `snapshot`
  sebelum menyimpulkan, `close` jika selesai.
- Instruksi `PINNED_ARTIFACT_INSTRUCTION` diperluas: untuk interaksi
  (scroll/klik) gunakan `browse_site`, bukan `view_site_page`.

Live factory `createBrowseSiteTools` di `packages/agent` dengan deps
injectable (`open/act/close` server-side), mengikuti pola
`createViewSitePageTools`.

### 3.2 Sesi browse — `apps/api/src/modules/static-sites/browse.ts` (baru)

- Registry in-memory per proses worker: key `${userId}:${sessionId}` →
  `{ browser, page, screencast, ref, actionsUsed, lastActionAt, interval }`.
- Batas: idle TTL **120 dtk** (sweeper interval 30 dtk + cek malas saat
  aksi), maks **12 aksi** per sesi, **1 sesi live per chat** (open kedua
  mengembalikan sesi yang ada + snapshot).
- Browser memakai **slot semaphore yang sama** dengan capture screenshot
  (`SITE_SCREENSHOT_MAX_CONCURRENT = 2`) supaya total browser ≤ 2.
- Navigasi: `page.route` menolak navigasi top-level ke origin selain
  `getApiOrigin()` (halaman preview hanya boleh navigasi in-page/anchor);
  permintaan yang diblokir dilaporkan sebagai `blocked` di hasil aksi.
- Dialog auto-dismiss; download tidak diterima; viewport 1440×900.
- Penutupan: `close` eksplisit, TTL, **dan hook `ChatRunInput.cleanup`**
  (per-run teardown yang sudah ada) — idempoten.

### 3.3 Live frame — di `browse.ts`

- `page.screencast.start({ size ≤ 1024×640, quality: 60, onFrame })` +
  `page.screencast.showActions({ cursor: "pointer" })`.
- Throttle: simpan hanya frame terakhir; tulis ke Redis
  `site-live:<sessionId>` (nilai base64 JPEG, `PX 30000`) paling cepat
  tiap **300 ms** (≈3 fps). Frame pertama ditulis segera setelah `open`.
- Saat sesi ditutup: `screencast.stop()`, hapus key Redis.
- Kegagalan redis ditelan dengan `console.warn` (live view tidak boleh
  menggagalkan aksi agent).

### 3.4 Event `siteLiveView` (client-data kecil)

- Server `client-events.ts`: skema `{ state: "started"|"stopped", siteId,
  label? }` + `ChatDataMap`/`ChatDataSchemas`/`ChatAppEvent` +
  `mapChatAppEvent` case `site_live_view`.
- **Wajib** daftarkan juga di `resumable-stream-store.ts`
  (`validDefaultData` + `DEFAULT_DATA_SCHEMAS`) — pelajaran dari
  `artifactFocus` yang sempat mati karena tidak terdaftar.
- Platform `client-data.ts`: tipe + parser + schema.
- `chat-message-row.tsx`: tambahkan ke daftar part data yang tidak dirender
  sebagai baris transkrip (`isRenderablePart`).
- `chat-session.tsx`: state `siteLiveView` + handler event.

### 3.5 API frame — `apps/api/src/modules/static-sites/download.ts`

`GET /api/sites/live/:sessionId/frame` (requireUser):

- Validasi kepemilikan sesi (`chatSession.findFirst({ id, userId })`) → 404
  jika bukan milik user.
- Baca `site-live:<sessionId>` → JPEG, header `content-type: image/jpeg`,
  `cache-control: no-store`; **204** bila tidak ada/kedaluwarsa.
- Tanpa query tambahan; UI memakai `cache-bust` sederhana (mis.
  `?t=<Date.now()>`).

### 3.6 UI — kartu live di atas composer

- Hook `use-site-live-frame(sessionId, active)`: poll `~350 ms` via
  `apiFetch` → blob → object URL (revoke saat ganti/unmount); 204 →
  pertahankan frame terakhir; error → status.
- Komponen `SiteLiveCard` di `chat-session.tsx` (region yang sama dengan
  banner artifactFocus, sebelum `<ChatComposer>`): judul `Live · {label}`,
  titik status pulse, gambar 16:9 (`aspect-video`, rounded), tombol
  **Hide** (menyembunyikan panel; sesi tetap berjalan dan bisa muncul lagi
  saat event `started` berikutnya), fallback skeleton sebelum frame
  pertama.
- Kartu hanya tampil saat `siteLiveView.state === "started"`; event
  `stopped` menyembunyikan; tidak ada kontrol stop dari UI (fase ini:
  agent/TTL yang menutup).

### 3.7 Batas operasional & keamanan

| Aspek | Nilai |
| --- | --- |
| Origin | Hanya `getApiOrigin()`; navigasi luar diblokir di route guard |
| Aksi | Maks 12 per sesi; satu aksi per tool call |
| Idle | 120 dtk → auto-close (sweeper 30 dtk) |
| Browser | Maks 2 total (berbagi semaphore dengan capture) |
| Frame | JPEG ≤ 1024×640 q60, tulisan Redis ≥300 ms, TTL 30 dtk |
| Cleanup | `close`, TTL, dan `ChatRunInput.cleanup` (idempoten) |
| Data | Frame hanya di Redis ephemeral; screenshot aksi masuk image store (scoped) |

Recipe: tambah tool → **bump `CHAT_AGENT_RECIPE_VERSION` 6 → 7** dan
perbarui literal di seluruh test (pola yang sama dengan bump sebelumnya).

## 4. Error handling

- Sesi tidak ada / sudah TTL / beda user → error eksplisit `"Browse
  session is not open — call open first."` (aksi), `204` (frame).
- `open` gagal (browser/timeout) → error retryable, tanpa sesi.
- Aksi gagal (selector tidak ketemu dll) → error pesan jelas + sesi tetap
  hidup; `actionsUsed` tidak bertambah? (diputuskan: aksi tetap dihitung —
  lebih sederhana dan mencegah loop).
- Navigasi diblokir → hasil sukses dengan `blocked: true` + penjelasan.
- Screenshot aksi gagal → hasil `captureError` + `retryable` (pola
  `view_site_page`), sesi tetap hidup.

## 5. Testing

- **Unit (agent)**: skema `browse_site` (satu tool baru, param wajib per
  aksi), factory (hasil + focus + vision buffer vs text-only), instruksi.
- **Unit (api)**: registry TTL/idle close, throttle frame (≥300 ms),
  navigasi diblokir, cleanup idempoten, guard ownership frame endpoint.
- **API route**: 401 tanpa auth, 404 bukan pemilik, 204 tanpa frame, 200
  JPEG saat ada.
- **DOM (platform)**: kartu live muncul saat event started, poll menukar
  frame, hide menyembunyikan, event stopped menutup; `isRenderablePart`
  mengabaikan `siteLiveView`.
- **E2E real-LLM (muse-spark, reasoning high)**: bangun site 2 seksi
  (nav anchor), pin, minta agent browse: `scroll` lalu `click` link
  "Kontak"; assertion: tool `browse_site` terpanggil ≥3x, endpoint frame
  mengembalikan JPEG ≥1x selama sesi, kartu live tampil di UI (screenshot
  evidence), jawaban menyebut konten seksi tujuan. Satu run text-only
  (deepseek) memastikan `view_image` terpanggil.
- **Manual (Playwright MCP)**: verifikasi visual kartu live + cursor pada
  sesi browse sungguhan.
- **Regresi**: seluruh suite unit yang ada tetap hijau; recipe v7 literals
  diperbarui.

## 6. Rollout

Satu branch/PR: modul browse + tool + event + endpoint + UI + tests +
recipe v7 + README (bagian live view). Tidak ada migrasi DB (Redis
ephemeral + image store yang ada). Browser provisioning mengikuti
dokumentasi Playwright yang sudah ada di README.

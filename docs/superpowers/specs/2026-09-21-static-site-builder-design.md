# Static Website Builder Design

Date: 2026-09-21
Branch: `feat/static-site-builder` (from `origin/main`)
Approach: A — sandbox-native agent loop (approved)

## Goal

User bisa meminta agent membangun static website (landing page) dari chat:
prompt → plan singkat → generate per-section → live preview → download zip `dist/`.
v1 hanya static output (tanpa backend, DB, auth, pembayaran).

## Context and research

- Repo `anreal`: chat streaming Anvia v1, multi-session, AI session titles,
  deep research, web search, image generation, OCR, queued follow-ups.
- Anvia lokal tertinggal: `core 1.0.9`, `client/server 1.0.10`,
  `react/react-ui 1.0.11`, tanpa `@anvia/sandbox`.
  Terbaru di npm: `core 1.5.0`, `sandbox 1.1.4`, `studio 1.2.4`.
  `anvia.dev/llms.txt` dan `llms-full.txt` 404 di root saat dicek 2026-09-21;
  referensi sandbox diambil dari GitHub `anvia-hq/anvia` + DeepWiki.
- API sandbox yang dipakai: `DockerSandbox` (ephemeral Docker),
  `exec/execStream`, `readFile/writeFile/listFiles`,
  `startProcess + waitForPort`, port publishing loopback-only untuk preview,
  `createSandboxTools` → `exec_command/read_file/write_file/list_files`
  dengan `allowedCommands/blockedCommands` + limit bytes,
  CLI `anvia-sandbox` untuk image (`node` + `playwright`).
- UX builder luar (v0, Lovable, Bolt): pola menang adalah
  Plan mode dulu (tujuan, audiens, 1 CTA) → build per-section
  (hero, proof, features, FAQ, kontak) → iterasi kecil → preview → publish.
  Prompt terstruktur: Goal → Struktur → Komponen → Behavior → Styling →
  Constraints. Konten harus asli, bukan lorem ipsum.

## Global constraints

- Upgrade semua Anvia ke versi terbaru yang kompatibel
  (`core`, `client`, `server`, `react`, `react-ui`, `mcp`, `qdrant`,
  tambah `sandbox`), lockfile diperbarui, `pnpm install --frozen-lockfile`
  hijau sebelum implementasi.
- Static-only: template Vite + Tailwind, output murni `dist/`.
  Tidak ada endpoint backend app, tabel DB baru, atau auth baru di v1:
  metadata build (`site.json`: id, version, status) disimpan sebagai file
  di direktori site, bukan Prisma — tanpa migration.
- Kode generasian tidak pernah dieksekusi di host; hanya di sandbox Docker.
- Semua publish event best-effort: gagal publish tidak menggagalkan job.
- Scope v1: Mini Vite project + preview + download zip.
  Bukan: custom domain, hosting publik, CMS, multi-page blog, pembayaran.

## Architecture

Modul baru `apps/api/src/modules/static-sites/` mengikuti pola
`session-titles` yang sudah ada: BullMQ queue `site-build` + service +
worker. Worker memegang satu `DockerSandbox` session per job dengan image
`node + playwright` dan tool allowlist ketat
(`npm`, `npx vite build`, `tsc --noEmit`; blokir `curl/wget/ssh`).

Alur: template ditulis ke `/workspace/site` → builder-agent iterasi
per-section → `vite build` → `startProcess (vite preview)` +
`waitForPort` → screenshot Playwright → zip `dist/` →
`GET /api/sites/:id/download` menyajikan file statis.
Platform hanya menampilkan screenshot/iframe preview yang di-proxy +
tombol download. Sandbox selalu di-destroy di `finally` dan terdaftar di
shutdown coordinator worker.

## Components

1. `packages/agent/src/sites/site-plan.ts` — ekstrak brief terstruktur
   (nama situs, audiens, 1 CTA utama, daftar sections, brand/vibe)
   via structured output. Tidak generate kode.
2. `packages/agent/src/sites/site-builder-agent.ts` — agent khusus dengan
   tepat 4 sandbox tools (`write_file`, `read_file`, `list_files`,
   `exec_command`). Aturan: satu batch tool-call per section, konten asli,
   patuhi `tokens.css`, larang placeholder.
3. `apps/api/src/modules/static-sites/queue.ts` — queue `site-build`,
   dedupe per `sessionId + siteId`.
4. `apps/api/src/modules/static-sites/service.ts` — config `SITE_ENABLED`
   (default true), `SITE_CONCURRENCY` (default 2), `SITE_MODEL`
   (default `deepseek/deepseek-v4-flash-0731`), `SITE_BUILD_TIMEOUT_MS`
   (5 menit); status build per versi.
5. `apps/api/src/modules/static-sites/worker.ts` — orkestrasi sandbox
   end-to-end dan penerbitan event progress/ready.
6. `apps/api/src/modules/static-sites/download.ts` — serve zip versi
   stabil terakhir.
7. `sites/template-vite/` — skeleton Vite + Tailwind minimal + `tokens.css`
   (tipografi, spacing, netral + satu aksen) sebagai anti-fingerprint.
8. Platform `sites/` — brief form ringkas, status build live, preview,
   tombol download, riwayat versi per session dengan rollback ke versi
   stabil sebelumnya.

## Data flow

1. Pesan user terdeteksi sebagai intent builder → tulis `site.json`
   (`id`, `sessionId`, `version`, `status: queued`) di direktori site → enqueue
   `site-build:{siteId}`. Enqueue gagal tidak menggagalkan chat.
2. Worker: sandbox session → tulis template → agent per-section →
   build → preview → screenshot → zip.
3. Event stream ke client mengikuti pola `sessionTitleUpdated`:
   `siteBuildProgress { siteId, version, phase, message }` selama jalan,
   `siteBuildReady { siteId, version, previewUrl, screenshotUrl,
   downloadUrl }` saat selesai. `refreshQuiet()` tetap fallback.
4. Iterasi ("ganti hero") = job baru, `version + 1`; file versi lama
   dipertahankan; download selalu dari versi stabil terakhir.

## Error handling

- Build gagal: status `failed` + pesan ringkas di panel + tombol retry
  tanpa menaikkan versi. Tidak ada state setengah jadi yang bisa diunduh.
- Timeout 5 menit per build; concurrency default 2.
- Tool di luar allowlist ditolak sebelum eksekusi.
- Gagal screenshot tidak menggagalkan build (preview tetap ada);
  gagal zip menggagalkan job dengan pesan jelas.
- Tanpa Docker yang jalan, worker menolak job dengan pesan eksplisit
  dan tidak crash.

## Testing

Unit (pola repo: `vi.hoisted` mocks, fake BullMQ `Queue`/`Worker`,
fake sandbox session, `jsdom` untuk DOM):

- `site-plan` parser: brief valid, tolak input kosong.
- queue: dedupe per site, payload lengkap.
- service: default config, status transisi (queued → running →
  ready/failed), rollback versi.
- worker: orkestrasi dengan sandbox mock (tulis → build → preview →
  screenshot → zip), publish event dipanggil, sandbox di-destroy saat gagal.
- download: serve zip stabil, 404 untuk versi tidak ada.
- platform: parser `siteBuildProgress`/`siteBuildReady`, state panel.

Integrasi real-LLM (wajib pakai model real, sesuai permintaan):

- Model tunggal untuk semua pengujian builder yang menyentuh LLM:
  `deepseek/deepseek-v4-flash-0731` via OpenRouter
  (`OPENAI_BASE_URL=https://openrouter.ai/api/v1` + key).
  Model ini terkonfirmasi ada di OpenRouter API 2026-09-21
  (`DeepSeek: DeepSeek V4 Flash 0731`) dan mendukung
  `structured_outputs`/`response_format` yang dipakai brief parser.
- Smoke manual real-LLM: `pnpm dev`, prompt landing page nyata,
  pastikan tiap section terisi konten asli, build sukses, preview tampil,
  zip terunduh dan berisi `index.html` + aset.
- Suite stub e2e tetap deterministik: `SITE_ENABLED=false` di
  `playwright.config.ts` seperti `TITLE_ENABLED=false`.

Verifikasi akhir: `agent`/`api`/`platform` test + `tsc --noEmit`
masing-masing hijau, `git diff --check` bersih.

## Out of scope / follow-ups

- Hosting publik dan custom domain.
- CMS / editing visual drag-and-drop.
- Multi-page blog, docs search, i18n.
- Backend app, database konten, auth, pembayaran.
- Regenerasi otomatis kualitas desain via lint deterministik
  (kandidat follow-up setelah v1 stabil).

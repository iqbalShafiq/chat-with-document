# Status: Agent Live Site Browse (fase 2) — branch `feat/agent-live-view-hardening`

Tanggal: 2026-09-26. Dokumen ini adalah handoff lintas-device. Ledger kerja
lengkap ada di `.superpowers/sdd/2026-09-26-agent-live-site-browse/progress.md`
(git-ignored, tidak ikut ter-push) — dokumen ini memuat semua yang penting.

## Ringkasan status

**Selesai.** Semua 7 task plan dieksekusi + seluruh temuan review akhir
(1 Critical, 2 Important) sudah diperbaiki dengan TDD dan ter-commit.
Sisa: buat PR + merge (user), dan daftar minor yang sengaja di-defer.

Spec: `docs/superpowers/specs/2026-09-26-agent-live-site-browse-design.md`
Plan: `docs/superpowers/plans/2026-09-26-agent-live-site-browse.md` (git-ignored;
isi task ada di ledger/commit messages).

## Commit utama (branch ini, di atas `main` b1a153d)

| Commit | Isi |
| --- | --- |
| `9eeb598` | bounded batch: watch hanya `src`, usage tap (unread), `artifactFocus` validator, README, rail tabs, label site |
| `0fdc586` | T1 `feat(agent)`: tool `browse_site` + factory |
| `7c9bf15` | T2 `feat(api)`: `BrowseSessionManager` + screencast throttle |
| `cb77c55` | T3 `feat(api)`: event `siteLiveView` + validator store |
| `d621787` | T4 `feat(api)`: wiring + cleanup + recipe v7 |
| `9c94e97` | T5 `feat(api)`: endpoint `GET /api/sites/live/:sessionId/frame` |
| `778543e` | T6 `feat(platform)`: kartu live + client-data |
| `c9df253` | T7 `test(e2e)` + README |
| `ffaff1e` | fix review Critical: `stopped` dikirim SEBELUM stream close + UI reset saat run end |
| `d713dd3` | fix review Important: navigasi terblokir tetap di preview + subresource hanya origin API |

## Bukti verifikasi

- Unit: agent **373/373**, platform **352/352**, api **698/701**
  (2 gagal pre-existing: `src/modules/chat/deep-research-wiring.test.ts`,
  `src/modules/chat/run-recipe-behavior.test.ts` — diverifikasi gagal juga di base).
- Fix pass: `browse.test.ts` + `run-worker.test.ts` **35/35**; platform chat/lib **182/182**;
  tsc api/platform bersih selain 1 error pre-existing `finalize-interrupted-tools.test.ts`.
- E2E real-LLM `apps/platform/e2e/site-live-browse.real-llm.e2e.ts`:
  **2/2 pass** (vision: kartu live + frame JPEG tersaji + `browse_site` ≥3x;
  text-only: `view_image` setelah browse). Screenshot bukti:
  `apps/.playwright-mcp/site-live-browse/*.png`.
- E2E rerun pasca-fix: **2/2 pass (3.8m)** — Critical 1 (stopped sebelum close)
  dan guard adapter baru tidak meregresi alur live browse.

Cara menjalankan (Windows, dari root repo; dev stack `pnpm dev` harus hidup,
API :4312 / platform :3000, `.env` berisi `OPENAI_BASE_URL` + `OPENAI_API_KEY`):

```powershell
pnpm --filter @anreal/agent exec vitest run
pnpm --filter @anreal/api exec vitest run
pnpm --filter @anreal/platform exec vitest run

# E2E real-LLM (dari apps/platform):
$map=@{}; Get-Content ../../.env | ForEach-Object { if ($_ -match '^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$') { $map[$matches[1]] = $matches[2].Trim().Trim('"') } }
$env:OPENAI_BASE_URL = $map['OPENAI_BASE_URL']; $env:OPENAI_API_KEY = $map['OPENAI_API_KEY']; $env:E2E_API_ORIGIN='http://localhost:4312'
node node_modules/@playwright/test/cli.js test --config playwright.real-llm.config.ts e2e/site-live-browse.real-llm.e2e.ts --reporter=line
```

## Keputusan (rulings) yang dibuat saat eksekusi

1. `BrowsePage.startScreencast(onFrame: (frame: { data: Buffer }) => void)` —
   callback menerima objek frame Playwright apa adanya (bukan Buffer telanjang).
2. `launch` mengembalikan browser adapter `{ newPage(): Promise<BrowsePage>; close() }`
   (`createPlaywrightBrowseBrowser`), bukan `ViewingBrowser` mentah; `createPage` dep dibuang.
3. `deps.notify` tetap 1 argumen `{state, siteId, label}`; default notify dibuat
   per-sesi (`defaultNotifyFor(sessionId)`) lewat bridge `setBrowseLiveNotifier`
   (di-set dari `build-run-input` per run).
4. OpenAPI: response 204/304 dikecualikan dari kewajiban example di
   `openapi/document.test.ts` (bodiless by definition); 200 binary diberi example string.
5. Test kartu live memakai real-timer `vi.waitFor` (bukan fake timers) — RTL
   `findByRole` + vitest fake timers menggantung di env ini; assertion perilaku sama.
6. E2E: assertion konten site memakai `/kontak/i` + salah satu kata detail kontak
   (LLM menulis ulang copy literal); verifikasi `view_image` memakai persisted
   `tool-result` (UI melabeli "Viewing image"), bukan teks DOM.

## Minor yang di-defer (dari review akhir; sengaja tidak dikerjakan)

1. Lazy idle check di `act` + refresh `lastActionAt` saat `open` sesi yang sudah ada
   (`apps/api/src/modules/static-sites/browse.ts`) — TTL efektif 120–150 dtk.
2. `stopLive` menunggu `notify` sebelum menutup page/browser; bikin `try/finally`
   agar leak mustahil bila notifier reject (default sudah menelan error).
3. `open` belum cek status versi `ready` (beda dengan `view_site_page`).
4. Paritas validator: `client-events.ts` mengizinkan `label: ""` (store menolak);
   platform `siteId` bound 200 vs server 120.
5. Vision buffer tak terbatas: beberapa screenshot browse dalam satu turn bisa
   menumpuk (pertimbangkan simpan hanya N terakhir / 1 per turn).
6. E2E `expectBrowseToolCalls` menghitung artikel transkrip (bukan persisted
   `tool-result`); assertion kontak bisa flake bila model menulis copy aneh.
7. `site-live-card.test.tsx` belum meng-assert `revokeObjectURL` saat ganti/unmount;
   endpoint frame query DB tiap poll ~350 ms (kandidat cache ownership singkat).
8. Screenshot saat `close` ikut antre ke vision buffer tanpa dipakai lagi.
9. Polling frame tidak di-pause saat `document.hidden`.

## Langkah berikutnya

1. `git push origin feat/agent-live-view-hardening` (dilakukan di sesi ini).
2. Buat PR ke `main`; user yang merge.
3. Opsional: kerjakan minor di atas; tambah E2E yang tidak pernah `close`
   untuk membuktikan `stopped` mengalir (Critical 1 sudah ada unit test urutannya).

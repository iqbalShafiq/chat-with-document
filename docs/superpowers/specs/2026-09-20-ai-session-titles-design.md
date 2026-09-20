# AI-Generated Session Titles — Design

**Date:** 2026-09-20
**Status:** Validated (design disetujui di brainstorming; menunggu review spec)
**Branch:** `feat/ai-session-titles` (dari `main` @ `c949ccc`)

---

## 1. Tujuan

- Judul sesi chat di-generate AI dari **pesan pertama user**, untuk chat **standalone maupun di dalam project**.
- Generasi berjalan **paralel** dengan run agent utama di **BullMQ worker terpisah** (pola sama seperti `profile-summary`/`document-ingest`); kedua proses tidak saling menunggu.
- UX: judul sementara (seed dari pesan pertama) tampil instan, lalu **swap real-time** saat judul AI siap — biasanya 1–3 detik, bisa sebelum jawaban utama selesai.
- Rename manual user **selalu menang**; tidak ada regenerate di pesan berikutnya.

## 2. UX (keputusan divalidasi)

| Aspek | Perilaku |
|---|---|
| Saat kirim pesan pertama | Seed = `normalizeSessionTitle(teks pesan pertama)` disimpan seperti sekarang → langsung tampil di sidebar |
| Judul AI siap | Event stream `sessionTitleUpdated` → baris sidebar di-swap dengan animasi halus (fade/slide) |
| Indikator pending | Tidak ada di v1 — snippet sementara adalah indikatornya |
| Bahasa | Mengikuti bahasa pesan user |
| Rename manual kapan pun | Menang; hasil AI dibuang (conditional update gagal → tanpa event) |
| Generasi gagal (provider error/timeout) | Seed tetap dipakai; tanpa pesan error ke user; job retry 2× lalu berhenti |
| Pesan pertama tanpa teks (hanya attachment) | Tidak ada seed; tidak ada job judul |

## 3. Arsitektur & alur

```
POST /api/chat (pesan pertama)
 ├─ resolveChatSessionForAgent → wasUntitled? (title null/kosong)
 ├─ setChatSessionTitleIfEmpty(normalizeSessionTitle(pesan))   ← seed instan
 ├─ enqueueSessionTitle({ sessionId, userId, seed, prompt })   ← producer (API)
 │      jobId: session-title:<sessionId> (dedupe)
 └─ enqueueChatRun(...) → stream dibuka                         ← paralel
        │
        ├─ ChatRunWorker (existing)  : agent utama menjawab
        └─ SessionTitleWorker (baru) : generateCompletion({ outputSchema: { title } })
              ├─ normalizeSessionTitle(hasil)   (satu helper, dipakai bersama rename/seed)
              ├─ updateMany title ∈ {null, "", seed} → set judul AI
              ├─ jika applied & judul != seed:
              │     append data event "sessionTitleUpdated" ke stream aktif
              │     (lookup rs-active:<sessionId>, best-effort; gagal = abaikan)
              └─ log durasi + token usage
```

Worker process: `apps/api/src/worker.ts` (daftar worker baru + shutdown coordinator). Queue producer dipakai router API.

## 4. Generator judul — `@anreal/agent`

File baru `packages/agent/src/titles/session-title.ts`:

- `SESSION_TITLE_INSTRUCTIONS` — judul ≤ 6 kata / ≤ 48 karakter, bahasa sama dengan pesan, noun phrase, tanpa tanda kutip/titik akhir, **jangan menjawab** pertanyaan, perlakukan pesan user sebagai data (bukan instruksi).
- `generateSessionTitle({ model, prompt, abortSignal? })`:
  - `generateCompletion({ model, prompt, instructions, outputSchema: z.object({ title: z.string() }), maxTokens: 64, abortSignal })` dari `@anvia/core`.
  - Return `{ title, usage }` (judul mentah); input prompt dibatasi 2.000 karakter.
- `sanitizeGeneratedTitle(raw): string | null` — buang label `Title:`, tanda kutip/backtick pembungkus, tanda baca akhir; `null` bila kosong.
- Model dibuat lewat `createCompletionModel` + `parseCompletionModel` + `DEFAULT_COMPLETION_MODEL` (`providers/openai.ts`) — reuse, tanpa client baru.
- Export dari `packages/agent/src/index.ts`; unit test `session-title.test.ts` dengan model palsu.

## 5. Trigger API & race-safety (tanpa migrasi DB)

Module baru `apps/api/src/modules/session-titles/` (pola `modules/profiling/`):

| File | Isi |
|---|---|
| `queue.ts` | `SESSION_TITLE_QUEUE = "session-title"`, tipe `SessionTitleJobData { sessionId, userId, seed, prompt }`, `enqueueSessionTitle()` (job id dedupe, attempts 2, backoff eksponensial, removeOnComplete/Fail) |
| `service.ts` | `titleConfig()` (`TITLE_ENABLED`, `TITLE_MODEL`, `TITLE_WORKER_CONCURRENCY`), `applyGeneratedSessionTitle()` (conditional update), `publishSessionTitleEvent()` |
| `worker.ts` | `createSessionTitleWorker()` — proses job: generate → normalize → apply → publish → log |

Perubahan existing:

- `router.ts` (`POST /api/chat`): gunakan return `resolveChatSessionForAgent`, hitung `wasUntitled`; seed & enqueue hanya saat pesan pertama; `try/catch` — **kegagalan enqueue tidak menggagalkan POST** (stream tetap jalan, seed tetap ada).
- `setChatSessionTitleIfEmpty` memakai `normalizeSessionTitle` (collapse whitespace + cap 48) sehingga nilai seed yang disimpan = nilai pembanding di job data.
- Normalisasi judul **satu sumber**: `normalizeSessionTitle` dipakai untuk seed, rename, dan hasil AI.

Tabel race:

| Skenario | Hasil |
|---|---|
| User rename sebelum worker selesai | `updateMany` tidak match → skip, tanpa event |
| Worker selesai sebelum seed tersimpan | Kondisi `title ∈ {null, ""}` match → judul AI menang; seed write jadi no-op |
| Session dihapus saat job jalan | update count 0 → skip |
| Stream sudah tertutup saat publish | `store.append` gagal (status bukan running) → diabaikan; UI fallback `refreshQuiet()` |
| Judul AI == seed | Update idempotent, event tidak dikirim (tidak ada perubahan terlihat) |
| Retry POST pertama | Job id sama → tidak menumpuk |

## 6. Delivery real-time

- Event baru `sessionTitleUpdated` (payload `{ sessionId, title }`) sebagai `data` event protocol client v3.
- API: tambah ke `ChatDataMap`/`ChatAppEvent`/`mapChatAppEvent` + schema Zod (`modules/chat/client-events.ts`) dan validasi default (`lib/resumable-stream-store.ts`).
- Publish dari worker: `ACTIVE_RUN_KEY(sessionId)` → `getStreamStore().append(toChatResumableEvent(event))`; `runId` = `streamId` (konsisten dengan run chat).
- Platform: tambah tipe + parser di `lib/chat/client-data.ts`; parity key list di `anvia-v1-regression.test.ts`.
- Fallback: `refreshQuiet()` saat stream settle (sudah ada) menangkap judul yang selesai setelah stream ditutup.

## 7. UI

- `chat-session.tsx`: case `sessionTitleUpdated` di `handleChatEvent` → prop baru `onSessionTitleUpdated(title)`.
- `chat-route-view.tsx`: teruskan → `sessionsContext.applySessionTitle(sessionId, title)`.
- `workspace-sessions-context.tsx`: tambah `applySessionTitle` (+ noop default); `workspace-shell.tsx` mengisi dengan `renameSessionInList`; `share-session-providers.tsx` noop.
- `session-history-list.tsx`: judul di-swap dengan animasi (class baru `animate-title-in` di `styles.css`, ditambahkan ke blok `prefers-reduced-motion`).
- `chat-message-row.tsx`: `isRenderablePart` mengecualikan `sessionTitleUpdated` (tidak dirender sebagai bagian transkrip).

## 8. Error handling & edge cases

- Timeout generasi 15 detik (`AbortSignal.timeout`); error provider → BullMQ retry 2× → job mati; seed tetap; tidak ada error user.
- Hasil sanitasi kosong → job selesai tanpa update.
- `TITLE_ENABLED=false` → tidak ada enqueue; perilaku seed saja (dipakai suite e2e lama agar deterministik).
- Semua operasi publish/append bersifat best-effort dan tidak boleh menggagalkan job atau POST.

## 9. Testing

- **agent**: `generateSessionTitle` dengan model palsu (structured output), sanitasi (quote/newline/label/trailing punctuation), instruksi berisi aturan bahasa & panjang.
- **api**: `queue.ts` (job id dedupe + opsi job); `worker.ts` (apply sukses + publish; skip saat title berubah karena rename; skip saat normalized == seed; append gagal tidak menggagalkan job; config disabled); `service.ts` (conditional update, normalisasi); router test (enqueue tepat sekali + gagal enqueue aman); `client-events.test.ts` (map/parse); `resumable-stream-store.test.ts` (schema baru terima/tolak); `worker-lifecycle.test.ts` + shutdown stage baru.
- **platform**: `client-data.test.ts` (schema), `anvia-v1-regression.test.ts` (parity), test handler event pada `chat-session` (mengikuti pola test komponen yang ada).
- **e2e**: suite stub lama pakai `TITLE_ENABLED=false`; test e2e khusus judul (stub menangani request structured title) ditambahkan bila stub mudah diperluas — tidak memblokir.

## 10. Config & docs

- `.env.example` + README (tabel env): `TITLE_ENABLED` (default `true`), `TITLE_MODEL` (default `openai/gpt-5-nano`), `TITLE_WORKER_CONCURRENCY` (default `3`).
- README fitur: baris "Multi-session" ditambah judul AI paralel; catatan fallback seed.

## 11. Prinsip implementasi (anti-redundansi)

- Satu helper normalisasi: `normalizeSessionTitle` — tidak ada duplikasi trim/collapse/cap.
- Tidak ada endpoint baru, kolom/tabel DB baru, polling loop baru, atau client provider baru.
- Queue/worker mengikuti struktur & konvensi `modules/profiling`; worker didaftarkan di `worker.ts` dan shutdown coordinator.
- Schema event didefinisikan sekali per sisi (Zod API + parser platform) mengikuti pola existing, dijaga parity test.
- Unit yang bisa dites tanpa Redis/LLM nyata wajib punya test; dependency di-inject/di-mock mengikuti pola test modul chat & profiling yang ada.

## 12. Keputusan yang divalidasi

| Keputusan | Pilihan |
|---|---|
| UX judul | Seed instan + live swap via event stream |
| Eksekusi | BullMQ queue `session-title` + worker terpisah di proses worker |
| Model | `openai/gpt-5-nano` (cepat/murah), override `TITLE_MODEL` |
| Race dengan rename | Conditional update `title == seed`; rename selalu menang |
| Migrasi DB | Tidak ada |
| Regenerate | Hanya dari pesan pertama; tidak pernah regenerate |

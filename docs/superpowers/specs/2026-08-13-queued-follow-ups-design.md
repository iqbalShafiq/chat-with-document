# Queued Follow-Ups (Send While Streaming) — Design

**Date:** 2026-08-13
**Status:** Validated (design approved after Q&A + research)
**Branch:** `feat/queued-follow-ups`

---

## 1. Core semantics

- Saat agent sedang streaming, composer tetap bisa dipakai: satu tombol di kanan bawah —
  composer kosong → **Stop**; composer terisi → **Queue** (ikon corner-down-left, accent).
  Enter = Queue.
- Pesan yang diantrekan disimpan sebagai **snapshot draft composer penuh** (bukan teks
  polos) dan ditampilkan di **queue dock** menempel di atas text field (di dalam
  `glass-composer`).
- **Send now** → injeksi ke run aktif lewat `PromptRequest.steer()` (SDK `@anvia/core`
  0.25.1 — *"enqueueing user messages at safe model-turn boundaries during active prompt
  runs"*): pesan masuk ke agent di turn boundary berikutnya, di **run yang sama** (memory
  runId, trace Langfuse, tool context tidak putus). Satu pesan per turn, FIFO.
- **Auto-flush**: run selesai normal (status `completed`) dan antrean tidak kosong →
  item berikutnya otomatis dikirim sebagai run baru (pipeline send normal). Setelah run
  itu selesai, item berikutnya lagi — berantai sampai antrean habis atau hold.
- **Hold**: auto-flush di-pause setelah **Stop** atau **run error**. Antrean tetap utuh;
  hanya kirim manual (Send now / modal) yang melanjutkan. Hold mencegah loop error.
- **Edit item**: klik chip → draft dimuat penuh ke composer (teks, attachment gambar,
  pinned images, context snippet), item tetap di slot-nya dengan status `editing`.
  Submit → draft baru menggantikan item di **slot yang sama** (urutan tidak berubah).
  Cancel (X di chip editing) → item kembali ke draft aslinya, composer dikosongkan.
- **Guard eksekusi**: item `editing` tidak pernah dieksekusi. Flush (auto maupun send
  now) memproses item `pending` berurutan dan **berhenti** saat mencapai item `editing` —
  menunggu edit selesai (submit/cancel) baru lanjut.
- Persistensi: antrean + urutan + seluruh isi draft tersimpan per session di
  localStorage; survive close tab / pindah session / reload. Hide dock = murni visual.

Referensi eksternal: Codex CLI ("Press Tab while Codex is working to queue a follow-up
prompt for the next turn"), Gemini "hold for follow-up" — satu pesan per turn, bukan
batch (batch bikin model hanya menjawab pesan terakhir dan mengaburkan batas approval/
klarifikasi).

## 2. Data model

### 2.1 Queue item (client)

```ts
type QueuedItem = {
  id: string;              // clientMessageId (uuid)
  text: string;            // boleh kosong jika hanya attachment
  attachments: QueueAttachment[]; // gambar lokal dari composer
  documentIds: string[];   // dokumen ter-link di rail (session-scoped)
  contextSnippet: { text: string; sourceRole: "user" | "assistant" } | null;
  pinnedImageIds: string[]; // generated images yang di-pin saat queue
  status: "pending" | "inflight" | "editing";
};

type QueueAttachment = {
  id: string; name: string; mediaType: string;
  data?: string;           // base64 / data URL dari composer attachment
  url?: string;
};
```

- Snapshot diambil dari state composer/route saat `queueMessage()`: teks input,
  `composer.attachments` (gambar), `activeDocumentIds` (rail), context snippet chip,
  `activeContextImages`.
- Toggle web search / image gen / model **tidak** di-snapshot — tetap session-scoped,
  dibaca live saat eksekusi (konsisten dengan send normal).

### 2.2 Storage (localStorage)

- Key: `chat.queue.<sessionId>` — JSON array terurut (indeks = urutan).
- Validasi saat baca: item yang bentuknya invalid dibuang; `status: "editing"` saat
  restore dinormalkan ke `"pending"` (composer kosong setelah reload).
- Quota guard: tulis dengan try/catch; jika `QuotaExceededError`, tulis ulang versi
  terdegradasi tanpa `attachments[].data` (teks + referensi tetap utuh), log warn.
- Pembersihan otomatis saat session dihapus tidak dilakukan (key kecil; orphan
  dibersihkan saat sessionId lama tidak pernah dibuka lagi — out of scope).

### 2.3 Server state (Redis)

- List `rs-steer:<streamId>` — pesan steered FIFO, item JSON `{ clientMessageId, text,
  attachments: [{ mediaType, data }], contextSnippet }`. `EXPIRE` 24 jam setiap push.
- `rs-active:<sessionId>` (existing) — resolusi stream aktif.
- Tidak ada tabel baru, tidak ada migrasi Prisma.

## 3. Server (`apps/api`)

### 3.1 `POST /api/chat/steer` (chat router, auth existing)

- Body: `{ sessionId: string, messages: SteerMessage[] }`; `SteerMessage =
  { clientMessageId, text, attachments?: { mediaType, data }[], contextSnippet? }`.
- Validasi (zod): `sessionId` wajib; 1–20 messages per request (client chunk jika lebih);
  `clientMessageId` 1–64 char; `text` 0–32k char (boleh kosong jika ada attachment);
  max 8 attachments per pesan; total body sanity cap (~15 MB).
- Resolve `GET rs-active:<sessionId>` → `streamId`. Tidak ada → `409
  { error, code: "NO_ACTIVE_RUN" }` (client fallback).
- Ownership: `store.getMeta(streamId).userId === user.id`, mismatch → 404.
- `RPUSH` tiap pesan ke `rs-steer:<streamId>` + `EXPIRE`. Return `{ ok: true, streamId,
  queued: n }`.

### 3.2 Worker pump (`run-worker.ts`)

- `requestRef = { current: PromptRequest }` — instance dibuat sekali per job dan dibangun
  ulang saat transient retry (`withTransientModelRetry.onRetry`). Saat retry, jika
  `activeSteer` belum ack, `steer()` ulang ke instance baru sebelum stream mulai (pesan
  antrean aman di-boundary pertama).
- Variabel `activeSteer: SteerMessage | null`. Loop event (`for await (const event of
  profiled)`):
  1. Jika `activeSteer` dan `event.type === "turn_start"` → `store.append({ type:
     "queued_message_applied", clientMessageId, text, attachmentCount })` **sebelum**
     event turn_start (bubble user muncul tepat saat giliran steered dimulai), lalu
     `activeSteer = null`.
  2. `store.append(event)`.
  3. Pump: jika `activeSteer === null` → `LPOP rs-steer:<streamId>` → parse; build
     `Message.user([...imageParts, ...textParts], { metadata: { clientMessageId,
     queued: true, createdAt } })` (attachment data → `UserContent.imageBase64`,
     snippet → prepend text block) → `ok = requestRef.current.steer(message)`.
     `ok` → `activeSteer = item`; `false` (run terminal) → buang + log (client
     me-revert sendiri saat stream end, tidak ada event reject).
- Serialisasi satu-per-turn otomatis: `activeSteer` menahan pop sampai turn steered
  selesai (`turn_start` berikutnya = turn item tersebut; drain SDK terjadi di turn
  boundary, tidak pernah mid-stream).
- Setelah `for await` selesai (normal / stop flag / error): drain + `DEL
  rs-steer:<streamId>` (log jumlah sisa). Item sisa tetap dimiliki client (revert
  inflight→pending di stream end).
- Approval/klarifikasi: pump hanya berjalan antar event — saat run suspend, pesan
  steered menunggu di Redis list sampai turn selesai. Konsisten dengan concern #1.
- Tidak ada perubahan pada tap chain (usage, citations, profile refresh) — event steered
  mengalir lewat stream yang sama. `finalizeAssistantCitations` tetap di stream end.
- Memory & trace: steering commit ke memory oleh SDK memory recorder dalam run yang sama
  (savePolicy "message"); satu trace Langfuse. Tidak ada penulisan memory app-side.
- `maxTurns` tetap default 20 — turn steered mengonsumsi budget. Kehabisan budget →
  run error → hold (accepted; user resume manual).

### 3.3 `POST /api/chat/queue/sync` (anti-duplikat lintas reload)

- Body `{ sessionId, ids: string[] }` (max 50, divalidasi). Query
  `agentMemoryMessage` (scope session + user, role `user`) → parse `message.metadata
  .clientMessageId` (pola `removeAppendedPromptRow`) → return `{ appliedIds: string[] }`.
- Dipakai client saat mount + sebelum auto-flush untuk membuang item yang sudah
  diterapkan server-side (kasus: tab close tepat setelah steer diterapkan sebelum ack
  sampai → tanpa ini item dikirim ulang dan duplikat di percakapan).

## 4. Client (`apps/platform`)

### 4.1 Lib `chat/queued-messages.ts` (pure, testable)

- `readQueue(sessionId)` / `writeQueue(sessionId, items)` (validasi + quota guard).
- Mutations murni: `addItem`, `removeItem`, `reorder(from, to)`, `markInflight(ids)`,
  `revertInflight()`, `applyAck(id)`, `startEdit(id)`, `finishEdit(id, draft)`,
  `cancelEdit(id)`, `nextFlushable(items)` (item `pending` pertama; bila item
  `editing` muncul lebih dulu dalam urutan, flush berhenti di situ).
- `buildDraft(...)` / `buildSteerPayload(item)` helpers.

### 4.2 Hook `hooks/use-queued-messages.ts`

- State + persist otomatis per `sessionId`; restore saat mount. API: `queueMessage(draft)`,
  `removeItem`, `reorder`, `recallToComposer(id)`, `submitEdit(draft)`, `cancelEdit`,
  `sendNow()`, `ackQueuedMessage(id)`, `revertInflight()`, `syncApplied()`.
- `queueMessage`: snapshot draft (teks, attachments, documentIds, snippet, pinned ids) →
  add item → clear composer (input + attachments) + clear chip snippet (termasuk DELETE
  server-side via hook existing) + unpin images (reuse handler existing).
- `sendNow`: tandai `pending` → `inflight` **berurutan sampai (bukan termasuk) item
  `editing` pertama** — item yang sedang diedit tidak pernah dipanggil; bila dia di
  urutan terdepan, send now menunggu edit selesai (sama seperti auto-flush) — lalu POST
  steer (chunk 20). Response `NO_ACTIVE_RUN` → revert ke `pending` → fallback: execute
  item pertama via pipeline send normal (ini sekaligus flush saat idle — hold tidak
  menghalangi send now).
- `ackQueuedMessage(id)`: hapus item dari antrean (dedupe bubble rejoin cukup lewat
  pengecekan `clientMessageId` di pesan existing + `queue/sync` untuk kasus ack terlewat).
- `syncApplied`: panggil `/api/chat/queue/sync`, buang item dengan id yang sudah applied.

### 4.3 Flush rules

- `holdRef` (in-memory, tidak dipersist): set saat klik Stop; set saat run error
  (`chat.status === "error"` atau event error stream); clear saat send now, modal "Send
  queue", atau antrean kosong. "Send new message" di modal **tidak** clear hold.
- Auto-flush effect: `chat.status` transisi `streaming → idle` **dan** saat mount dalam
  kondisi idle: jika `!hold` dan ada `nextFlushable` → `syncApplied()` → execute item
  (pipeline send normal, reuse fungsi submit existing). Rantai berlanjut tiap stream end.
- Eksekusi item via run baru: upload gambar lokal (`uploadSessionImage` +
  `addSessionImageContext`), wait dokumen ready (`waitForDocumentReady`), upsert snippet
  (PUT existing), `sendMessage` dengan metadata `clientMessageId` (dedupe +
  `queued: true`), lalu hapus item dari antrean.
- Eksekusi item via steer: upload gambar lokal agar masuk galeri (`uploadSessionImage`),
  ambil data URL (`GET /api/images/:id` + pinned images), build `SteerMessage` (snippet
  diprepend sebagai blok teks), POST steer. Dokumen sudah session-linked; document tools
  tersedia sepanjang run.
- Modal konflik: submit manual saat `idle` + antrean non-empty → `QueueConflictDialog`
  (reuse `DialogShell`/`ConfirmDialog`):
  - **Cancel** — tutup, draft tetap di composer.
  - **Send queue** — draft composer ditambahkan ke antrean (slot terakhir), composer
    di-clear, hold di-clear, flush antrean.
  - **Send new message** — draft composer dikirim sekarang via pipeline normal; antrean
    tetap utuh dan tetap hold.
- Guard composer-clear: effect "optimistic clear saat streaming" existing di-skip bila
  run berasal dari auto-flush (ref flag) supaya draft user tidak terhapus.

### 4.4 Komponen `components/composer/message-queue-dock.tsx`

- Posisi: di dalam `glass-composer`, di atas baris input (setelah chip snippet), menempel
  ke text field. Tidak ada perubahan layout dock.
- **Collapsed** (default): chip item pertama — 1 baris, `truncate` (ellipsize end),
  badge kecil bila ada konten non-teks (`+2 img`, `+1 doc`). Kanan: tombol **Send now**
  (accent, hidden bila tidak ada `pending`), tombol expand (chevron), tombol hide
  (EyeOff). Bila antrean > 1: text button **"load more (N)"** di bawah chip pertama.
- **Expanded**: klik load more → animasi expand (transisi height/grid-rows,
  `cubic-bezier(0.16,1,0.3,1)`), semua item tampil, max 3 item terlihat, scroll vertikal
  `chat-scroll` dengan scrollbar gaya existing. Klik chevron → collapse.
- **Chip item**: drag handle (GripVertical) — drag & drop **native HTML5** (tanpa
  dependency baru), reorder → persist. Klik teks → `recallToComposer`. X → hapus.
- **Chip editing**: abu-abu + label "editing…", X = cancel edit.
- **Hidden**: dock menyusut jadi pill tipis "N queued · show" (klik → tampil lagi).
  Murni visual — auto-flush tetap berjalan.
- Animasi masuk/keluar konsisten pola existing (`animate-fade-up`, exit 180ms seperti
  ContextSnippetChip).
- Aksesibilitas: aria-label per tombol, `role="list"` untuk daftar item.

### 4.5 Integrasi composer & route

- `chat-composer.tsx`:
  - Saat streaming: tombol Stop ↔ Queue berdasarkan isi composer (teks/attachment
    non-kosong). Sumber state teks: `useComposer` / input events dari
    `composerInputRef` (implementasi pakai API `@anvia/react-ui` yang tersedia).
  - `ComposerAttachControl` **diaktifkan saat streaming** (disabled hanya saat
    `isIngesting`) supaya draft kaya bisa disusun; model switcher tetap disabled saat
    busy (model run-scoped).
  - `submitMessage` handler bercabang: streaming → `queueMessage`; idle + antrean
    non-empty → buka modal konflik; idle normal → pipeline existing.
- `routes/index.tsx`:
  - Ekstrak pipeline submit existing menjadi helper `sendDraft(...)` yang dipakai send
    manual, auto-flush, dan modal "Send new message" (reuse, tanpa duplikasi).
  - `handleChatEvent` cabang baru `queued_message_applied`: `ackQueuedMessage(id)` +
    append bubble user bila belum ada (dedupe `clientMessageId` via helpers
    `message-metadata` existing; penting untuk rejoin/resume replay). Bubble menampilkan
    teks + thumbnail attachment dari data item antrean.
  - Auto-flush effect + `holdRef` + modal state + wiring dock props.
  - Stop handler: existing `onStopRun` + `holdRef = true`.
- Rejoin/resume: antrean restore dari localStorage sebelum resume selesai; event
  `queued_message_applied` yang ter-replay di-dedupe; item yang sudah applied di-purge
  oleh `syncApplied`.

## 5. Batasan eksplisit

- Tidak ada persistensi server-side untuk antrean itu sendiri (input user yang belum
  terkirim = client-owned).
- Steered item tidak ikut inject dokumen sebagai context block saat run-start (dokumen
  hanya bisa diakses agent lewat document tools; context catalog run-start tidak
  berubah). Dokumen pada item yang dieksekusi via run baru berperilaku penuh seperti
  send normal.
- Tidak ada sync antrean antar-tab (localStorage per tab; run aktif tetap digembok oleh
  lock existing — tab kedua yang steer akan dapat `NO_ACTIVE_RUN` → fallback send normal
  yang kena `409 RUN_ACTIVE`, perilaku existing).
- `maxTurns` 20 per run tidak diubah; turn steered ikut mengonsumsi budget.
- Resubmit / edit pesan / regenerate saat streaming tetap diblokir seperti sekarang.
- Queue item hanya bisa diedit satu-per-satu (composer = satu permukaan edit).

## 6. Error handling & edge cases

- `steer()` false (run terminal) → item dibuang server-side; client revert
  inflight→pending saat stream end → auto-flush kirim ulang via run baru (dengan
  `syncApplied` menjaga tidak ada duplikat).
- Steer endpoint `NO_ACTIVE_RUN` → client fallback ke pipeline normal (send now) atau
  menahan (auto-flush saat idle dengan lock kosong — sama saja).
- Run error → hold + banner existing (`previousRunError`); antrean utuh.
- Stop → hold; stop flag existing memberhentikan stream; pump drain list di akhir.
- localStorage quota → degradasi attachment (4.2/2.2) tanpa kehilangan teks/urutan.
- Item di antrean saat session di-rename/delete → tidak terpengaruh (key per sessionId;
  orphan kecil diabaikan).
- Duplikat lintas reload → `queue/sync` (3.3).
- Approval muncul saat item menunggu steer → item tetap di Redis list sampai turn
  selesai (tidak ada race, pump serial per event).
- Upload gambar gagal saat eksekusi steer → item tetap pending + `composerError`
  existing, tidak hilang.

## 7. Testing

- **API (vitest)**:
  - `steer` endpoint: validasi body, ownership (user lain → 404), `NO_ACTIVE_RUN`,
    RPUSH + TTL (fake redis pola `approval-registry.test.ts`).
  - Worker pump: serialisasi satu-per-turn (fake agent stream generator + fake store),
    ordering ack sebelum `turn_start`, `steer()` false → buang, drain + DEL setelah
    loop selesai, re-steer saat transient retry.
  - `queue/sync`: appliedIds dari memory rows (fake prisma), cap 50, ownership.
- **Platform (vitest)**: `queued-messages` lib (add/reorder/edit-slot/ack/revert/
  nextFlushable + validasi restore + quota degrade), flush-rule helpers, payload builder
  (snippet prepend, attachment mapping).
- **E2E (Playwright, stub LLM)**: tambah skenario stub bila perlu (stream lambat):
  1. Kirim pesan pertama → saat streaming ketik follow-up → Enter → chip antrean tampil,
     composer kosong, tombol Queue/Stop berganti sesuai isi; klik Send now → request
     provider kedua berisi teks follow-up; bubble user + reply muncul.
  2. Stop → hold → ketik pesan baru → send → modal 3 tombol; "Send queue" → request
     provider berisi teks antrean.
  3. Reload page → antrean + urutan pulih; auto-flush mengirim item.
- **Verifikasi**: `pnpm --filter api test`, `pnpm --filter platform test`,
  `pnpm --filter @assingment/agent test`, typecheck + build `apps/api` (tsc) &
  `apps/platform` (vite build), `pnpm --filter platform exec playwright test`.

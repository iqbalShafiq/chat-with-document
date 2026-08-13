# Additional Context (Text Context Snippet) — Design

**Date:** 2026-08-12
**Status:** Validated (3 design sections approved)
**Branch:** `feat/context-snippets`

---

## 1. Data model & API (single snippet per session)

- **Schema** — satu baris per session (`sessionId` unique; operasi add baru = replace/upsert):
  ```prisma
  model SessionContextSnippet {
    id         String   @id @default(cuid())
    userId     String
    sessionId  String   @unique
    text       String   @db.Text
    sourceRole String   // "user" | "assistant"
    createdAt  DateTime @default(now())
    updatedAt  DateTime @updatedAt

    @@index([userId])
    @@map("session_context_snippet")
  }
  ```
- Cap: 2000 karakter per snippet (server-validated, client juga trim). Tidak ada batas jumlah (selalu 1).
- **Service baru** `apps/api/src/modules/chat/context-snippets.ts` — mirror pola `createImageStore` (DI `deps.prisma`, testable):
  - `getSessionContextSnippet({ userId, sessionId })` → validasi kepemilikan session via `chatSession` (404/empty jika bukan milik user), return snippet atau null.
  - `upsertContextSnippet({ userId, sessionId, text, sourceRole })` → replace (upsert by `sessionId`), return snippet.
  - `removeContextSnippet({ userId, snippetId })` → deleteMany scoped user+snippet.
  - `clearSessionContextSnippet({ userId, sessionId })` → deleteMany scoped user+session (single-use, dipanggil worker).
  - Singleton `getContextSnippetStore()` mirror `getImageStore()`.
- **Endpoints** (chat router, auth middleware existing):
  - `GET /api/chat/:sessionId/context-snippet` → snippet saat ini atau null.
  - `PUT /api/chat/:sessionId/context-snippet` body `{ text, sourceRole }` → upsert, return snippet.
  - `DELETE /api/chat/context-snippet/:snippetId` → hapus.

## 2. Server-side injection & life cycle

- **`build-run-input.ts`**: setelah blok `active_image_context`, load snippet via store; jika ada, push context block:
  ```
  id: "session_context_snippet"
  text: "User-selected context\n" + deskripsi + "1. (from user message) …" / "(from assistant message) …"
  ```
  Return `activeContextSnippet` di runInput (null jika kosong). Tidak mengusik image context — tabel, endpoint, state, dan clear terpisah.
- **`run-worker.ts`**: setelah `buildChatRunInput`, jika `activeContextSnippet` ada → `clearSessionContextSnippet` (best-effort, mirror image context baris 229-235). Single-use per generate.
- **Persist bubble user**: client menyertakan `contextSnippet: { text, sourceRole }` di metadata `sendMessage` → memory store menyimpan metadata → `loadEnrichedMemoryMessages` mengembalikannya → bubble tampil setelah reload. Server tidak menulis metadata.

## 3. Frontend

- **Selection popover** — komponen baru `MessageSelectionToolbar` per bubble di `ChatMessageRow`:
  - Trigger `selectionchange`/`mouseup`; validasi anchor + focus node di dalam container bubble yang sama; posisi dari `getSelection().getRangeAt(0).getBoundingClientRect()`, fixed-position di atas seleksi, clamp viewport.
  - Hide: klik luar, scroll, Escape, seleksi collapse, pesan sedang diedit.
  - Tombol "Add as context" → normalize teks (reuse `stripCitationsForCopy` untuk marker `[[cite:…]]`, trim, cap 2000) → hook shared upsert → clear seleksi.
  - Subtle animation fade + scale-in (150ms, `cubic-bezier(0.16,1,0.3,1)`).
- **Reply icon** di `MessageActionsBar`, setelah `MessageCopyButton` (kanan icon copy), user DAN assistant:
  - Icon `Reply` (lucide), aria-label "Add message as context".
  - Behavior: seluruh teks pesan sebagai context (assistant: strip citations via `stripCitationsForCopy`; user: raw text) → upsert yang sama. Disabled saat pesan tanpa teks.
  - Urutan: `[Citations (assistant)] [Copy] [Reply] [Edit (user)] [Regenerate (user)]`.
- **Shared hook** `hooks/use-context-snippet.ts` — dipegang `routes/index.tsx`, di-pass ke composer & message rows:
  - State: `snippet: ContextSnippet | null`, `loading`, `error`.
  - Actions: `refresh()` (GET saat mount/ganti session), `setSnippet(text, sourceRole)` (optimistic PUT, revert saat gagal), `remove()` (DELETE optimistic).
- **Chip composer** — komponen baru `ContextSnippetChip` (reusable, variant read-only untuk bubble) di atas textfield, sejajar area `activeContextImages`:
  - Icon + label "Additional context" + sumber ("from your message" / "from assistant").
  - Teks line-clamp 2 baris; hover → popover semua baris (reuse `HoverCard` jika cocok).
  - Tombol expand/collapse (Chevron, subtle), tombol X hapus (DELETE optimistic + exit animation).
  - Enter animation fade + translateY; exit fade + collapse.
- **Bubble user**: extend `ChatMessageMeta` → `contextSnippet?: { text, sourceRole }` + `readChatMessageMeta`/`withChatMessageMeta`. Saat send, `contextSnippet` disertakan di metadata `sendMessage`; bubble render versi read-only chip (collapsible + hover popover, tanpa tombol hapus) di atas teks.

## 4. Error handling & edge cases

- Gagal API (get/upsert/delete): `composerError` existing; optimistic revert ke kondisi terakhir valid.
- Upsert gagal dari popover: state error singkat di popover, seleksi dipertahankan.
- Gagal send (409): pesan user di-remove; chip composer TIDAK dihapus (clear hanya setelah `sendPromise` sukses — mirror `activeContextImages`).
- Stream error: run sudah konsumsi snippet dari DB → chip hilang; bubble pesan gagal tetap menampilkan context dari metadata (`writeFailedPair` mempertahankan metadata prompt).
- Seleksi kosong/whitespace-only atau melintasi dua bubble → popover tidak muncul.
- Teks > 2000 karakter → dipotong client-side, divalidasi ulang server-side.
- Pesan diedit → popover mati. Streaming → reply icon & seleksi tetap aktif; send tetap diblokir streaming.
- Snippet sudah ada → operasi baru = replace tanpa konfirmasi.

## 5. Testing

- **API (vitest)**: service context-snippets — upsert replace, ownership (session milik user lain ditolak), clear single-use, cap 2000 karakter (mirror `images/service.test.ts`, fake prisma DI).
- **build-run-input**: context block terbentuk hanya saat snippet ada (mock store).
- **run-worker**: snippet di-clear setelah run mengkonsumsi.
- **Platform (vitest)**: `message-metadata` read/write `contextSnippet` (mirror `message-text.test.ts`), normalisasi teks seleksi (strip citation, trim, cap).
- **Verifikasi**: `pnpm --filter api test`, `pnpm --filter platform test`, typecheck + lint + build kedua app, migration `pnpm --filter api db:migrate -- --name add_session_context_snippet` (DB via docker-compose).

# Session Rename/Delete + Profile Provenance — Design

**Date:** 2026-08-12
**Status:** Validated (4 design sections approved)
**Branch:** `feat/session-rename-delete`

---

## 1. UI: rename & delete session di sidebar

- **Tombol aksi**: icon titik tiga (`MoreHorizontal`, lucide) di sisi kanan tiap item history. Selalu terlihat di item **aktif**; muncul saat **hover** item lain (opacity + scale, `group/row` Tailwind). Focusable, `aria-haspopup="menu"`, `aria-expanded`.
- **Popover**: menu Rename/Delete muncul **di samping kanan item, sejajar vertikal** (top-align). Dirender via **portal `document.body`, `position: fixed`** (z-50, di atas drawer mobile) karena sidebar `overflow-hidden` memotong absolute positioning. Extend `PopoverMenu` (components/ui/popover-menu.tsx) dengan mode `floating` opsional — pemakaian existing (projects-browser, composer) tidak berubah. Close: klik luar, Escape, **scroll apa pun** (sidebar scrollable), flip ke atas saat mepet bottom viewport.
- **Rename modal**: `DialogShell` (sm, content) + `FormTextField` (maxLength 48, Enter submit, busy/error inline) — pattern modal "Create project".
- **Delete modal**: `ConfirmDialog` (busy + error + restoreFocus). Deskripsi menyesuaikan kalau session running (run akan dihentikan); catatan "documents & personalized preferences are not affected".
- **Animasi**: reveal hover (opacity/scale), popover `animate-scale-in`, row yang dihapus play `animate-fade-out` (~220ms) sebelum dihapus dari list (state `exitingIds` di `SessionHistoryList`).
- **Delete session aktif**: navigasi ke empty draft → item terbaru → draft baru (logika `loadSessionsFirstPage`); hapus id dari `activeRuns`.

## 2. Backend: endpoint rename & delete

- **`PATCH /api/chat/sessions/:id`** `{ title }`: normalisasi trim + collapse whitespace + cap 48 chars. 400 kosong, 404 bukan milik user. Rename aman saat running (worker tidak menimpa title non-kosong).
- **`DELETE /api/chat/sessions/:id?confirm=true`** (pattern projects; 400 tanpa confirm).
- **Stop-then-delete** (keputusan terpilih):
  1. Ownership check (404).
  2. Active run via `rs-active:{sessionId}`; jika stream running: stop flag → cancel pending approvals/clarifications → **poll lock release ≤8s**. Timeout → **409** "still processing".
  3. Lock ada tapi stream mati → stale, drop langsung (worker mati tak bisa resurrect karena memory store `upsert`).
  4. **Snapshot bounded** user messages (≤12 pesan, cap ~8k chars) sebelum hapus (untuk §4).
  5. Hard delete: perluas `deleteChatSessionsHard` dengan cleanup `sessionImageContext` (tanpa FK, selama ini terlewat). Dokumen, generated images, profil = aset user, tidak terhapus.

## 3. Provenance memory personalization (user + project scope)

- **Explicit facts**: `{ section, fact, createdAt, source?: { sessionId, messageId } }` — `messageId` = `clientMessageId` prompt (null utk client lama). Wiring: `buildChatRunInput` ditambah input `promptMessage` → `createRememberUserProfileTool` → `appendExplicitFact`. JSON → tanpa migration; row lama kompatibel.
- **Implicit sections**: bullet `string` → `{ text, sources: string[] }`. Delta di-prompt dengan tag `(session <id>)`; `loadProfileDelta` men-select `memorySession.sessionId`. Instruksi summarizer: atribusi sumber dari tag; bullet lama membawa sources-nya.
- **Compat layer**: `normalizeProfileBullet`/`normalizeProfileSections` di agent package; dipakai API `toProfileData` + platform (`lib/api.ts`, `personalization-section.tsx` render `.text`). Evals/fixtures tidak terdampak.
- Atribusi implicit LLM-based (bisa "unknown") — konsisten dengan reconsideration yang juga LLM-based.

## 4. Reconsideration saat delete (bareng worker yang sama)

- Delete handler: `enqueueProfileReconsideration(scope, { deletedSessionId, snapshot })` — fire-and-forget, scope user (+ project jika session dalam project).
- Queue sama (`profile-summary`): pending list **array JSON capped 5** di key Redis `profile:reconsider:<scope>` (TTL 24 jam); enqueue selalu menjamin ada job.
- Worker sama, **satu call LLM**: `summarizeProfileForScope(scope, { reconsiderations })` jalan walau delta kosong; `buildProfileSummaryText` menambah blok `DELETED CONVERSATIONS` (id + snapshot) + instruksi `RE-EXAMINE` (hapus bullet yang hanya dipelajari dari session itu; drop session id dari sources; explicit fact dengan source cocok dihapus kecuali terkonfirmasi ulang). Delta + reconsideration digabung dalam satu prompt.
- Watermark **tidak dimajukan** pada pass reconsideration murni; pending di-clear **setelah sukses** (retry membawa ulang).
- No-op: profil kosong / snapshot kosong → skip LLM call.
- Tidak ada tabel/kolom baru; hanya key Redis sementara.

---

## Catatan keputusan yang divalidasi

| Keputusan | Pilihan |
|---|---|
| Delete saat worker aktif | Stop dulu, lalu delete (409 fallback) |
| Memory saat session di-delete | Tidak dihapus; profil di-*reconsider* via LLM (non-deterministik) di worker yang sama |
| Format sections | `{ text, sources }` dengan compat data lama |
| Storage provenance | Di dalam JSON existing — tanpa migration |

---

## Implementation notes

- Settle window is **12s** (`RUN_SETTLE_TIMEOUT_MS`, poll 400ms), not the 8s in §2 — gives the worker time to observe the stop flag and release the lock under load.
- Pending reconsiderations are stored as a Redis **LIST** `profile:reconsider:<scope>` (JSON entries, capped 5, TTL 24h), not the JSON array key in §4; consumed entries are removed exactly-after-success via `lrem`.
- Added a **liveness check** in `stopActiveRunForSession`: the lock is dropped for terminal job states (`completed`/`failed`/`unknown`) only — waiting/delayed/active/absent still have a worker that may write memory.
- Added a **relock guard** immediately before the hard delete (a stale tab can re-acquire the lock while the snapshot is captured) and a **worker-side existence guard** (a queued job for a deleted session skips and releases the lock instead of resurrecting the memory row via upsert).
- The snapshot is captured **before** the delete (fencing against row removal); profile reconsideration is enqueued only when the snapshot is non-empty.
- Last-session delete recovers to an empty draft / newest remaining session / new draft — no dead-end state.

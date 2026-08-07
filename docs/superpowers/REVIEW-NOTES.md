# Review Notes — feat/context-window-compaction (2026-08-07)

Status saat commit terakhir: semua fitur selesai, final review selesai, **satu fix wave belum di-re-review** (lihat di bawah). Branch belum di-merge ke main.

## Yang perlu direview dulu (sebelum merge)

1. **Fix wave terakhir (commit terakhir di branch, pesan diawali `fix(platform): silent sidebar refresh`)** — hasil final-review finding #1 (Important): polling 10 detik kini memanggil `loadSessionsFirstPage({ silent: true })` yang:
   - tidak mem-flash loading state,
   - tidak memotong pagination (in-place merge halaman pertama dengan list yang ada),
   - tidak mengganti sessionId aktif,
   - memaksa `unread: false` untuk session aktif (anti-race mark-read).
   **Belum di-review ulang** (scoped re-review dibatalkan karena keterbatasan waktu). Perlu: tsc + build PASS (sudah diverifikasi exit 0 saat commit), smoke singkat (background completion → sidebar tidak flash, list tidak reset), lalu re-review reviewer.
2. **Deferred minors dari final review** (triage: semua DEFER, tapi layak dipertimbangkan):
   - Task 2: scan Redis bisa menghasilkan key duplikat; N+1 per key (get + 2 hgetall) — fine di skala polling 10s; error Redis per-key me-500 seluruh poll (pertimbangkan catch per-key).
   - Task 3: `listActiveRuns` hanya validasi `sessionId`/`streamId` (status/lastEventId dipercaya).
   - Task 4: default `activeRuns` di AppShell alokasi Set baru tiap render (hoist konstanta kalau komponen pernah di-memo); row running belum `aria-busy`; inset bar (`inset-x-3`) beda 2px dari padding teks row (`px-3.5`).
   - Task 5: settle-effect kurang `sessionId` di dependency array (aman karena ChatSession di-remount per session via key, tapi tambahkan untuk hygiene); local unread clear bisa race dengan POST mark-read gagal (self-healing); `setActiveRuns` alokasi Set baru tiap poll.
   - Migrasi: `lastReadAt` nullable → semua session lama ber-dot unread di load pertama (one-time artifact; opsional backfill `lastReadAt = updatedAt`).
3. **Fitur besar (context window, compaction, worker, resumable stream) sudah final-review bersih** — tidak perlu review ulang.

## Ringkasan state

- Branch: `feat/context-window-compaction` (dari `main` @ 0fb0b0c)
- Fitur: model registry DB (Luna + DeepSeek V4 Flash 0731, OpenRouter ids, brand icons, reasoning efforts low/medium/high/max), context-usage indicator + popover, compaction non-destruktif dengan segments, chat-run worker + resumable streams + rejoin, failure persistence + error bubble, sidebar session status (running progress bar + unread marker).
- Fix yang sudah diterapkan dan terverifikasi: reasoning-part strip (DeepSeek Responses 400), dedupe failed-prompt row, retry transien "model does not exist", model-preferences restore, silent sidebar refresh.
- Catatan lingkungan: pernah ada multiple stale worker processes — selalu mulai dengan **satu** `pnpm dev` fresh (kill semua node app dulu). `.env` butuh `OPENAI_BASE_URL=https://openrouter.ai/api/v1` + key OpenRouter; `PROFILE_SUMMARY_MODEL=openai/gpt-5.6-luna`.
- SDD workspace untuk fitur sidebar: `.superpowers/sdd/2026-08-07-sidebar-session-status/` (ledger + briefs + reports + review packages — gitignored).

## Langkah selanjutnya yang disarankan

1. Scoped re-review commit fix wave (diff: commit terakhir).
2. Merge `feat/context-window-compaction` ke `main` (atau buat PR).
3. Opsional: backfill `lastReadAt`, tambah `sessionId` dep, hoist EMPTY set — sesuai daftar deferred.

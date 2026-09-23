# User Skills + Self-serve MCP — Design Spec

Date: 2026-09-23
Status: Written 2026-09-23, pending user review of this file before implementation plan.

## 1. Shared understanding

**Intended outcome:** setiap user bisa upgrade agent-nya sendiri tanpa admin:
1) menambah Skills — upload file markdown maupun tulis sendiri, dan
2) connect ke MCP server secara mandiri (paste URL → test → save).

**Placement (decided by user):** 2 menu baru — `MCP` dan `Skills` — di additional menu (tombol plus) pada textfield chat composer. Klik menu → modal. Item yang sudah dibuat reusable. Status on/off terakhir diingat: **global default + override per-chat** (decided 2026-09-23). Additional menu menampilkan count indicator untuk MCP aktif dan Skills aktif (extend parameter komponen, bukan komponen duplikat).

**Constraints (from user):**
- Reuse/extend components, logics, helpers, utils yang ada; buat baru hanya jika reusable & scalable dan belum ada yang serupa (sudah dicek — lihat §2).
- MCP sebaiknya ada test/test-connection sebelum save.
- Nol error compile, lint, typecheck; automated tests hijau.
- Pragmatis, logis, konsisten, tidak redundan, testable.
- E2E nanti: Playwright MCP di browser real + LLM real (tanpa stub), user `shafiq@testing.com` / `Test@123` (register dulu jika belum ada).

**Success criteria:** user bisa (a) tulis/upload skill → aktif → agent memakai prosedurnya, (b) tambah MCP via URL → test hijau → tools MCP dipakai agent → revoke/off → chat tetap jalan (fail-closed), (c) toggle terakhir diingat global + bisa dioverride per-chat, (d) count aktif terlihat di plus-menu.

## 2. Current state (verified 2026-09-23)

- Plus-menu = `FeaturesPopover` (`apps/platform/src/components/composer/features-popover.tsx:12-24` props; trigger plus `179-197`; two-segment active shell `199-296`; portaled panel `299-461` dengan row `role="switch"`). Dipakai di `chat-composer.tsx:462-474`.
- Tidak ada pill count generik: `ProvenanceBadge` spesifik dokumen, `message-queue-dock.tsx:12-22` badge teks (`+N img`), `citations-info-button.tsx:69` countLabel. → butuh `ui/count-badge.tsx` baru yang reusable.
- Modal: `ui/dialog-shell.tsx` (accessible `<dialog>` shell), `ui/form-field.tsx` (`FormTextField`/`FormTextAreaField`), `ui/select.tsx`, `ui/button.tsx`, `ui/confirm-dialog.tsx`. `settings-modal.tsx` pola sectioned dialog.
- Agent wrapper `packages/agent/src/agent.ts:39-53` expose `additionalInstructions/additionalContext/additionalTools/mcpServers` — belum ada param `skills`. Native skills tersedia di installed `@anvia/core 1.5.0` (`dist/skills/{load,local,tools,types}`, `SkillValidationError`).
- MCP mapan: `packages/agent/src/tools/context7.ts:93-107` (StreamableHTTP + `ssrfProtection:"strict"` + degrade `null`), `apps/api/src/lib/context7-server.ts` (process-lifetime, fail-closed). Wiring tunggal `apps/api/src/modules/chat/build-run-input.ts` (recipe → `additionalInstructions/additionalTools/mcpServers`, cf. `1304/1319/1535`). Recipe `run-recipe.ts` versi 2 dengan bounded zod (`ID_MAX/SHORT_TEXT_MAX/CONTEXT_TEXT_MAX/INSTRUCTION_TEXT_MAX/ARRAY_MAX`). Capabilities di `apps/api/src/openapi/paths/chat.ts:1330` (`context7Configured` dkk).
- Branch saat ini `feat/static-site-builder` — implementasi fitur ini wajib di branch baru.

## 3. Approaches considered

- **(A) Native Anvia — RECOMMENDED.** Skills via `loadSkills` atas direktori per-user yang dimaterialize dari DB + `skill.local(...)` (default; custom `SkillLoader` hanya bila API-nya terbukti mendukung di versi terinstall — diputuskan di plan) + `SkillValidationError` path-spesifik; MCP per-run `McpClient` (hanya `streamableHttp` https) + `McpClientGroup` + registrasi reviewed-subset `[{ name, tools }]` + `close()` selalu. Pro: semantik resmi (`docs.anvia.dev/sdk/advanced/skills`, `/sdk/advanced/mcp`), validasi bawaan, katalog kompak (hemat token), trust boundary jelas. Kontra: perlu 1 field `skills` di wrapper + recipe v3 + 2 tabel Prisma — semua terisolasi.
- **(B) Fallback instructions/context + pool MCP global — REJECTED.** Cepat tapi: tanpa validasi SKILL.md, full body selalu di prompt (boros token, tanpa progressive disclosure), pool global = bocor antar tenant, melanggar "application owns connection scope".
- **(C) Gateway broker penuh (credential vault + pool + proxy) — DEFERRED.** Tepat untuk 50+ server/OAuth refresh terpusat, tapi butuh service baru. Desain v1 disiapkan agar bisa naik ke (C) tanpa ubah kontrak UI/recipe.

## 4. Design

### 4.1 Architecture & ownership

App owns: authN/Z, ownership checks (`userId`), persistence, kredensial (server-side saja), allowed-tool review, recipe snapshot, approval policy, proyeksi event ke browser. Anvia owns: validasi skill, discovery tools MCP, registrasi `skills`/`mcpServers`, lifecycle `connect()`/`close()`. Browser tidak pernah melihat kredensial, reasoning mentah, atau argumen tool sensitif (proyeksi `@anvia/client`/`@anvia/server` yang ada tetap dipakai).

### 4.2 Data model (Prisma, baru — source of truth di DB)

- `UserSkill`: `id, userId, name (slug, unique per user), description, bodyMd, isEnabled (global default), status (active|invalid), issuesJson?, version, createdAt, updatedAt`. Batas v1: single `SKILL.md` body (upload `.md` / tulis). Cap: ≤20 active per user. Validasi nama ikut aturan Anvia (lowercase-hyphen, ≤64; description ≤1024).
- `UserMcpServer`: `id, userId, name (unique per user), url (https only), authType (none|bearer), credentialsRef (terenkripsi at-rest, hanya server), allowedToolsJson (subset review), isEnabled (global default), status (untested|ok|error), lastCheckedAt?, lastError?, createdAt, updatedAt`. Cap: ≤5 per user. v1 transport HANYA `streamableHttp`; `stdio` dilarang (server tidak spawn command user). OAuth penuh deferred (§5).
- Seleksi per-chat: TIDAK ada tabel baru. Client mengirim `skillIds[]` + `mcpServerIds[]` per request (default = seleksi terakhir di localStorage); server validasi ownership + `isEnabled`/status, lalu snapshot konten beku ke recipe. "Terakhir on ya on": `isEnabled` (DB, global) × seleksi terakhir (`localStorage` `anreal.skills.selection` / `anreal.mcp.selection`) × override per-chat (state sesi).

### 4.3 Backend

- Router CRUD `/api/skills`, `/api/mcp-servers` (pola `modules/profiling/router.ts`): zod ketat, ownership `userId` di setiap query, error terikat (404 untuk milik orang lain = 404, bukan 403-detail).
- Validasi skill server-side memakai loader Anvia yang sama dengan runtime (satu sumber kebenaran); `SkillValidationError.issues` dipetakan ke error field `{ path, message }`. Tidak ada regex validasi sendiri (anti redundansi).
- `POST /api/mcp-servers/test` (tanpa persist): body `{ url, authType, credentials? }` → `McpClient` + timeout ±15s → `connect()` → kembalikan `{ ok, toolCount, tools: [{name, description}] }` atau `{ ok:false, error }` yang bounded (tanpa secret/stack). `close()` selalu. dipakai tombol Test di modal maupun sebelum save.
- Recipe bump `CHAT_AGENT_RECIPE_VERSION 2→3`: tambah snapshot bounded `userSkills: [{id,name,description,bodyMd}]` + `userMcp: [{id,name,url,allowedTools,toolDefinitions}]` memakai konstanta bound yang sama (`run-recipe.ts:10-16`) + pola tool-definition beku ala `CONTEXT7_TOOL_DEFINITIONS`. Fail-closed: snapshot MCP tak bisa di-resolve di worker → run gagal dengan pesan terbaca (bukan chat rusak diam-diam), sama seperti `build-run-input.ts:1053-1054`.
- `build-run-input.ts`: resolve skills user → `skills` (native) pada `createAgent` (tambah 1 field `skills?`, cf. `agent.ts:39-53`); resolve MCP user → `McpClient` per-run + registrasi reviewed-subset + prefix nama tool per-server (hindari tabrakan nama yang menggagalkan konstruksi Agent). Konteks/token: katalog kompak skills selalu; body penuh dimuat on-demand oleh generated tools Anvia.
- Capabilities: extend `/api/chat/capabilities` dengan `userSkillsCount`, `userMcpConfigured` (boolean/count saja — tanpa URL/kredensial).

### 4.4 Frontend (extend dulu, buat baru hanya yang belum ada)

- `FeaturesPopover`: extend props dengan `skillsSummary { active, total, enabled }`, `mcpSummary {…}`, `onOpenSkills()`, `onOpenMcp()`. Tambah 2 row setelah Image generator (ikon `Brain`/`Plug` lucide — cek ketersediaan saat implementasi, fallback ikon netral), tiap row: label + **`CountBadge`** + switch. Trigger two-segment shell ikut menampilkan ikon skills/MCP saat ada yang aktif (pola `199-296`).
- **Baru (satu-satunya komponen UI baru): `ui/count-badge.tsx`** — pill numerik generik `{ count, label, tone? }`, `aria-label` lengkap, dipakai kedua row + bisa dipakai ulang fitur lain. Tidak ada komponen serupa (sudah dicek §2).
- `SkillsModal` + `McpModal` (baru, di `components/skills/` & `components/mcp/`): `DialogShell size="lg" heightMode="viewport"` + `FormTextField` (nama) + `FormTextAreaField` (SKILL.md / deskripsi) + `Select` (authType) + `Button` + `ConfirmDialog` (hapus). States: loading skeleton, empty ("belum ada — tulis pertama"), error field-spesifik, testing (spinner + disable save), sukses (toast/inline + tutup + refresh list).
- Hooks `useUserSkills` / `useUserMcpServers` (pola `useProfilePersonalization`): fetch, create, update, remove, test; `lib/api.ts` tambah client fns tipis.
- State composer: `chat-session.tsx` pegang `activeSkillIds/activeMcpIds` per sesi (default dari localStorage seleksi terakhir ∩ katalog `isEnabled`); teruskan ke `ChatComposer` → `FeaturesPopover`. Toggle row = flip seleksi sesi + persist localStorage; on/off global (`isEnabled`) diatur di dalam modal per item.
- A11y: row `role="switch" aria-checked`, modal fokus-trap + Esc/backdrop via `DialogShell`, count terbaca screen-reader (`"3 skills aktif"`).

### 4.5 Validation & error mapping

SKILL.md: struktur/frontmatter/nama/deskripsi via Anvia; masalah tampil di field yang tepat + status `invalid` (tidak bisa di-enable sampai lolos). MCP: URL harus https (tolak http/IP privat/host lokal), `allowedTools` subset dari hasil test, error koneksi bounded. Semua error model-facing disanitasi (tanpa secret/SQL/stack).

### 4.6 Budgets

`SKILL.md` >500 baris: warning (anjuran progressive disclosure ala best practice Claude). Estimasi token skills+MCP masuk `context-usage` yang sama (pola `context-usage.ts`). MCP connect timeout + cap item (§4.2) menjaga latensi/biaya.

## 5. Out of scope (v1)

- OAuth 2.1/PKCE penuh + refresh vault (auth v1: none/bearer saja); folder skill multi-file (`references/`, `scripts/` executable); marketplace/katalog MCP publik; share skill antar user; admin moderation; gateway broker (C). Semua dirancang agar bisa ditambah tanpa mengubah kontrak §4.

## 6. Verification

- `pnpm --filter @anreal/agent exec tsc --noEmit`, `pnpm --filter @anreal/api exec tsc --noEmit`, `pnpm --filter @anreal/platform exec tsc --noEmit` — 0 error; `vitest run` per paket hijau; eslint file tersentuh bersih.
- Unit: validasi nama/deskripsi, mapping `SkillValidationError`, ownership (amil milik orang = 404), recipe schema v3 bound-reject, prefix tabrakan nama tool.
- Integration: worker resolve skills+MCP snapshot; MCP unreachable → fail-closed terbaca.
- **E2E (real, tanpa stub, via Playwright MCP di browser):** register/login `shafiq@testing.com` / `Test@123` bila belum ada; (1) tulis skill → enable → chat memanggil prosedurnya (assert output mengikuti skill); (2) upload `.md` → aktif; (3) tambah MCP URL → Test hijau → save → enable → tool MCP terpanggil; (4) matikan → count 0 → chat normal; (5) reload → status terakhir bertahan (global) + override per-chat bekerja.

## 7. Implementation milestones (detail di plan)

1. Prisma + migrate + CRUD + validasi skill. 2. Test-connection + tabel MCP + review subset. 3. Recipe v3 + wiring + worker lifecycle. 4. `CountBadge` + extend `FeaturesPopover` + state sesi. 5. `SkillsModal` + `McpModal` + hooks + api client. 6. Capabilities + count + enforcement. 7. Unit/integration hijau. 8. E2E real LLM + Playwright MCP.

*Assumptions (koreksi bila salah): v1 single-MD skill; MCP auth none/bearer; caps 20 skills / 5 MCP; localStorage untuk seleksi terakhir; implementasi di branch baru.*

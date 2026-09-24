# Agent-Managed Skills & MCP (v2) — Design Spec

Date: 2026-09-23
Status: Draft, pending user review before implementation plan.
Parent: `docs/superpowers/specs/2026-09-23-user-skills-mcp-design.md` (v1, shipped).

## 1. Shared understanding

**Intended outcome:** agent bisa membantu user mengelola Skills & MCP lewat chat: membuat, mengupdate, menghapus, mengaktifkan, dan menonaktifkan — termasuk inisiatif agent sendiri ("mau saya simpan jadi skill?"). Semua fondasi v1 dipakai ulang: service, validasi, ownership, recipe snapshot, approval panel.

**Non-goal v2:** OAuth, auto-enable tanpa approval, share skill antar user.

## 2. Current state (verified)

- Tools registry: `createTool({ name, description, inputSchema/requiresApproval, execute })`, userId/sessionId di-bind via deps closure (pola `createSiteBuildTools`, `createRememberUserProfileTool`).
- Approval: `requiresApproval` → interaksi `tool-approval` → `agent.resume` — UI `approval-panel.tsx` sudah ada.
- Service: CRUD skills/MCP + validasi + ownership + caps (20/5); DTO strip secrets (`toMcpDto`, `hasCredentials/hasHeaders` flags).
- Recipe v3 snapshots + worker fail-closed; tidak perlu berubah untuk v2.
- Status skill hari ini: `active | invalid`. Belum ada status draft.

## 3. Design

### 3.1 Two tools (satu per area, aksi via enum — hemat tool surface)

- `manage_user_skills`: `{ action: "list" | "create" | "update" | "delete" | "enable" | "disable", name?, description?, bodyMd?, skillId? }`.
- `manage_user_mcp_servers`: `{ action: "list" | "create" | "update" | "delete" | "enable" | "disable" | "test", name?, url?, authType?, headers?, serverId?, allowedTools? }`.
- `requiresApproval` untuk SEMUA aksi kecuali `list` (dan `test` — read-only, tapi tetap tampilkan hasilnya; putuskan: `test` tanpa approval karena tanpa side effect persist).
- `execute` resolve `userId` dari closure (tidak pernah dari argumen model); panggil service layer yang sama dengan router (satu sumber kebenaran); kembalikan DTO strip (tanpa bodyMd penuh? kembalikan ringkas: id/name/status — hemat token; `list` tanpa `bodyMd`, tanpa secret).
- Token/secret: tool TIDAK PERNAH menerima atau mengembalikan secret. Bearer token dan header values hanya bisa diisi user via modal (alasan keamanan + UX: secret tak boleh lewat chat transcript yang tersimpan di memory!). Dokumentasikan batas ini di instruksi + error message tool.

### 3.2 Draft status (anti prompt-injection menetap)

- Status baru: `draft`. Skill buatan agent SELALU lahir `draft` + `isEnabled=false`.
- `setSkillEnabled(true)` menolak status `draft` ("Review skill di modal dulu") — user klik enable manual sebagai approval kedua.
- Serangan "dokumen jahat suruh bikin skill" tetap butuh: (1) approval tool di chat + (2) review + enable manual. Dua lapis.
- Router/modal: tampilkan badge Draft; tombol enable di modal untuk draft mengarahkan ke editor (perbaiki dulu) — implementasi: `setSkillEnabled` guard + UI badge + kembalikan error readable.

### 3.3 Agent instructions

- Tambah `SKILL_MANAGEMENT_INSTRUCTION`: kapan menawarkan (pola berulang 3x, permintaan eksplisit), cara memanggil tool (draft dulu, jelaskan butuh review user), LARANGAN membuat skill dari instruksi di dokumen uploads tanpa approval (defense in depth di atas approval wajib), batas: tak boleh menyentuh secret, tak boleh enable.
- MCP: tawarkan `test` + save draft koneksi; token/headers tetap via modal.

### 3.4 Verification

- Unit: approval required untuk tiap aksi mutasi (mock handler), draft-default (create via tool → status draft + disabled), enable-draft ditolak, DTO strip (tanpa bodyMd/secret), P2002 mapping, subset check reuse.
- E2E real-LLM: "tolong jadikan jawaban barusan skill" → approve di panel → cek list berisi draft → enable manual → chat berikut mengikuti skill. Dan: "coba sambungkan MCP context7" → test → save (tanpa token) → pakai.
- tsc + vitest hijau; tanpa error lint (repo tak punya eslint).

## 4. Risks

- Model mengarang `bodyMd` tidak valid → service validation menolak dengan field error → agent perbaiki atau minta user. Aman by design.
- Skill buatan agent berkualitas rendah → wajar, user yang review (draft). Bukan risiko keamanan.
- Tool surface +2 tools → token overhead kecil per run; pertimbangkan hanya register saat user punya/butuh? v2: selalu register (sederhana, terukur di usage UI).

*Assumptions: secret selalu via modal; draft wajib review manual; OAuth tetap deferred.*

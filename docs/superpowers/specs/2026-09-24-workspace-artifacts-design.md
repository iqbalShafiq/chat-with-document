# Workspace Artifacts Layer — Design Spec (Spec A)

Date: 2026-09-24
Status: Written 2026-09-24, pending user review of this file before implementation plan.
Branch: `feat/workspace-artifacts` (new, from `main@808f2b5`).

## 1. Shared understanding

**Intended outcome:** chat tetap tempat ngobrol, tapi semua hasil kerja menjadi artifacts kelas-satu di satu rak bersama yang bisa dilihat dan dimanipulasi agent lintas session: dokumen/laporan PDF, image assets, static sites, tasks, schedules, web bundles, dan session itu sendiri. Agent terasa pintar karena fleksibel menguasai platform, bukan karena banyak tool lepas.

**User decisions (locked):**
1. Scope = Spec A (Artifacts Layer), bukan silo per fitur, bukan full OS agent.
2. Arah Power workspace: share/export, project workflow, kolaborasi ringan — dashboard ROI terpisah, tidak dicampur ke spec ini.
3. Session termasuk artifact (read-only ringkas) agar agent bisa melihat percakapan di session lain milik user yang sama.
4. Project scope ketat: standalone hanya lihat standalone; project X hanya lihat project X.
5. Chart/analisis harus bisa masuk PDF (via snapshot jadi image asset).
6. Manipulasi dari session lain = update artifact yang sama (versioned), bukan duplikat.
7. Realtime + clarification visual: user melihat artifact yang ditunjuk agent; `request_clarification` mendukung pilihan berupa artifact dengan tipe jelas.
8. Image wajib punya caption searchable (generate, upload, cache dari web).

**Constraints (from user):**
- Reuse/extend components, logics, helpers, utils yang ada; buat baru hanya jika reusable & scalable dan sudah dicek belum ada yang serupa (§2).
- UI/UX ikut best practice + convention repo (glass, `DialogShell`, `ManagementRow`, `CountBadge`, dsb), tidak membingungkan; setiap state dipikirkan: loading, empty, error, success.
- Left sidebar / right sidebar / chat room punya fungsi berbeda — diatur sesuai fungsinya (§4.5).
- Pragmatis, logis, konsisten, tidak redundan, testable.
- Nol error compile, lint, typecheck; automated tests hijau.
- Testing perilaku agent dengan real LLM `muse-spark-1.3-contributor` reasoning medium/high untuk percakapan; image boleh stub (credits terbatas); chat dilarang stub.
- Gunakan MCP + skills yang dibutuhkan, terutama Anvia: baca skill + docs resmi via `anvia.dev/llms.txt` dan `https://github.com/anvia-hq/anvia`.
- Branch baru + penamaan branch / commit messages ikut convention (`feat/...`, `feat(...):`, `fix(...):`, `docs:`, `test(e2e):`).

**Success criteria:** user bisa (a) minta PDF dari dokumen + web + angka/chart analisis dengan sitasi, (b) pakai ulang image lintas session ke PDF/site via caption search, (c) lanjutkan/edit site dari session lain tanpa duplikat, (d) bikin/ubah task + schedule dari chat, (e) agent bertanya dengan picker visual saat ragu, (f) scoping project tidak bocor, (g) semua state UI jelas dan tidak error/lint/typecheck.

## 2. Current state (verified 2026-09-24)

**Persistence (Prisma `apps/api/prisma/schema.prisma`):**
- `Project`, `ChatSession` (+`ChatShare` frozen snapshot), `AgentMemorySession/Message` (`scopeKey=[sessionId,userId]`).
- `Document` (`origin: upload|created|fetched`, `parentDocumentId`, `originUrl`, `tabularData`), `DocumentPage` (`rawMarkdown`, `images Json?` + `annotation` opsional), `DocumentSession` (many-to-many).
- `GeneratedImage` (`prompt, source: generated|web, sourceUrl, modelId, width/height`) — TIDAK ada `caption/description`. Deskripsi web (`web_search images[] {url,description}`) hanya transit di output tool.
- `UserSkill`, `UserMcpServer`, `UserProfile/ProjectProfile`, `AgentUsageEvent`, `ChatModel` registry.
- Tidak ada tabel task/schedule/report/bundle. Sites file-based (`site.json` + `sites-index.json` key `sessionId` saja — `service.ts:99-156`, `worker.ts:306`).

**Agent tools (`packages/agent/src/tools/`):**
- `documents.ts`: `find_documents`, `search_document_pages`, `get_document_next_page`, `get_document_page_images` — scoping sudah benar (`projectId null vs exact match`, `resolveSessionDocumentIds:261-287`).
- `tabular/`: `read_dataset`, `analyze_dataset` (profile/aggregate/correlation/regression/ttest/anova/outliers/crosstab + chart spec untuk UI), `query_dataset_sql`, `extract_document_tables`, `create_chart` (`chart-tools.ts:66` bar/line/scatter/histogram/pie, komputasi server-side) + `derived-tools` (save CSV turunan), `fetch-csv/parse-csv/parse-xlsx/sql/markdown-tables`. Output chart = JSON spec (`labels/series/points/bins`) untuk render client (`platform/src/lib/data-analysis.ts`, `components/data/data-chart.tsx`), BUKAN file PNG.
- `data-analysis.ts`: hanya helper math (`mean`, `pearsonCorrelation`), bukan tool.
- `clarification.ts`: generik `createQuestionTool` (teks/choices), tanpa tipe artifact.
- `site-build.ts`, `image-generation.ts`, `web-search.ts` (`images[]` + `view_image`), `deep-research.ts`, `user-skills/mcp.ts`, `context7.ts`.

**HTTP (`apps/api/src/modules/`):**
- `chat/public-share-router.ts` (frozen snapshot, tanpa auth, token unguessable), `static-sites/download.ts` (zip/preview/rollback/by-session — preview publik capability URL, mutasi authed).
- `documents/router.ts`, `images/router.ts` (`toImageMetadata` tidak pernah expose `r2Key`), `projects/router.ts`, `skills/`, `mcp-servers/`, `usage/`, `models/`, `profiling/`.
- Stream events: `site_build_progress` via `publish()` (`worker.ts:176`), `queued_message_applied`, approvals/clarifications idempoten.

**Frontend (`apps/platform/src/`):**
- Shell: `layout/app-shell.tsx` (sidebar 272px + `ChatTopBar` + `content-frame`), `workspace/` (`chat-route-view.tsx` loading skeleton → `ChatSession` → missing).
- Left = navigasi: `sidebar/chat-sidebar.tsx` + `session-history-list.tsx` (sessions/projects/documents entry).
- Center = chat room: `chat/chat-session.tsx` + `chat-message-row.tsx` + `composer/chat-composer.tsx` + `composerTopSlot` dipakai `SiteBuildPanel`.
- Right/kontekstual: `session-documents-panel.tsx`, `tool-activity-panel.tsx`, `reasoning-panel.tsx`, `sites/site-build-panel.tsx`, `images/image-gallery-modal.tsx`, `documents/documents-browser.tsx`, `data/data-chart.tsx` + `chart-embed.tsx`.
- Interaksi: `chat/clarification-panel.tsx` (radio teks + input, tanpa visual picker), `chat/approval-panel.tsx`, `share/*`, `ui/` (`dialog-shell`, `management-row`, `count-badge`, `select`, `switch`, `confirm-dialog`, `button`, `form-field`).
- Tidak ada: artifact rail terpadu, `artifact_focus` event, caption editor, task/schedule panel, chart→PNG bridge.

## 3. Approaches considered

- **(A) Artifacts Layer — RECOMMENDED.** Satu taksonomi + satu aturan scope + tool CRUD seragam (`list/get/create/update`), semua ID lintas-referensi. Pro: agent fleksibel, anti duplikat, token hemat (katalog ringkas + ambil detail on-demand). Kontra: perlu migrasi index sites + kolom caption + 2 tabel baru — semua terisolasi, no breaking change ke chat path.
- **(B) Silo per fitur — REJECTED.** PDF tool sendiri, site-list sendiri, task sendiri tanpa model bersama. Cepat 1–2 minggu tapi format ID beda-beda, agent bingung, UX fragmented, duplikat where-clause scoping di tiap router.
- **(C) Full OS agent (browser control penuh) — DEFERRED.** Tepat untuk 50+ integrasi enterprise, tapi butuh sandbox/browser service + governance baru. Desain A disiapkan agar bisa naik ke C tanpa ubah kontrak artifact.

## 4. Design

### 4.1 Architecture & ownership

App owns: authN/Z, ownership (`userId`), scope (`projectId`), persistence, caption backfill, chart snapshot, PDF render, schedule worker, recipe snapshot, approval policy, proyeksi event ke browser. Anvia owns: agent loop, `createQuestionTool` extension pattern, memory/compaction, MCP/skill runtime. Browser tidak pernah melihat `r2Key`, kredensial, reasoning mentah (proyeksi `@anvia/client`/`@anvia/server` yang ada tetap dipakai).

Prinsip: server enforce scope (bukan janji prompt); katalog ringkas di prompt, body penuh on-demand; mutasi idempoten dengan `id`; semua yang bisa dilihat user punya loading/empty/error/success.

### 4.2 Artifact taxonomy (final)

| Type | Storage | Agent ops | UI ops | Keterangan |
|---|---|---|---|---|
| `document` (upload + derived + `kind=report`) | `Document` + `DocumentPage` | find/search/get page/images | library modal, preview pane, provenance badge | PDF = derived doc `origin=created, kind=report, citationMap` |
| `image_asset` | `GeneratedImage` + `caption` baru | `find_images` (caption+prompt), get, use-in | gallery modal, thumbnail, caption editor | unify generated/upload/web-cache/doc-chart-snapshot |
| `web_bundle` | baru (frozen url+snapshot+images[]) | list/get | citations popover, sources rail | bekukan hasil web agar PDF/site tidak link-mati |
| `site` | migrasi index → `userId+projectId` (+ manifest tetap) | list/get/update (v+1) | build panel, preview iframe, versions+rollback | edit lintas session = versi baru, bukan site baru |
| `workspace_task` | tabel baru | create/update/list | tasks panel, checkbox rows | `inbox|doing|done`, `sourceChatId`, due |
| `workspace_schedule` | tabel baru + BullMQ `workspace-schedule` | create/list/cancel | schedules panel | MVP: one-shot + daily/weekly saja |
| `chat_session` | `ChatSession` + memory excerpt | `list_sessions`, `get_session_excerpt` | history list (tetap) | read-only ringkas, bukan full dump |
| `share/export` | `ChatShare` + export jobs | create share, export md/pdf/csv/zip | share modal, download buttons | perluasan share yang ada |

### 4.3 Scope rule (server-enforced)

- Session standalone (`projectId null`) → `WHERE userId AND projectId IS NULL`.
- Session project X → `WHERE userId AND projectId = X`.
- Tidak ada fallback "lihat semua". Setiap `list_*` wajib bawa `sessionProjectId` dari server (bukan dari argumen model). Pola ikut `resolveSessionDocumentIds` yang sudah benar. Share/export turunan mewarisi scope sumber.

### 4.4 Data model (Prisma + files)

- `GeneratedImage.caption String @default("")` + index `[userId, caption]` (trigram/fulltext bila perlu); backfill `caption = prompt` untuk data lama; upload/generate/cache-web wajib isi caption (auto-generate via vision helper murah bila kosong — reuse pola `view_image` text-only).
- `Document.kind String @default("source")` (`source|report`), `citationMap Json?` untuk report (`[{claim, documentId?, pageIndex?, webBundleId?, url?}]`).
- `WebBundle`: `id, userId, projectId?, title, sources Json (frozen), createdAt` + index `[userId, projectId, createdAt]`.
- `WorkspaceTask`: `id, userId, projectId?, title, status, sourceSessionId?, dueAt?, createdAt, updatedAt` + index `[userId, projectId, status]`.
- `WorkspaceSchedule`: `id, userId, projectId?, title, prompt, freq (once|daily|weekly), nextRunAt, status, createdAt` + index `[userId, status, nextRunAt]`.
- Sites: TIDAK pindah ke DB di v1; `sites-index.json` dimigrasi ke index `userId+projectId → [{siteId, siteName, updatedAt}]` (backward-compat baca format lama `sessionId → ...`). `listSitesBySession` dipertahankan sebagai wrapper, tambah `listSitesByScope`.

### 4.5 Backend

- Router baru ikut pola `modules/profiling/router.ts` (zod ketat, ownership per query, 404 untuk milik orang lain): `/api/artifacts` (list/get terpadu, filter `type, projectId` dari session server-side), `/api/reports` (create/edit PDF), `/api/artifacts/images` (caption update + `find`), `/api/tasks`, `/api/schedules`, `/api/web-bundles`, `/api/charts/snapshot`.
- `create_pdf_report(input: {title, markdown, assetIds[], citationMap?, projectId?})`: resolve asset IDs dalam scope → render pdfmake (ringan; Puppeteer deferred — Chromium 150–400MB tidak dibayar di v1) → simpan derived `Document(kind=report)` → kembalikan `documentId`. `edit_pdf_report(id, ...)` = revisi, bukan file baru.
- `snapshot_chart(chartSpec)`: render server-side (headless chart → PNG, library diputuskan di plan setelah cek `data-chart.tsx` renderer) → simpan `GeneratedImage(source=chart, caption auto)` → kembalikan `imageId` siap embed.
- `use_image_in(imageId, target: {pdfId|siteId})`: resolve scope + cache web URL ke R2 sekali (anti link-mati).
- Schedule worker `workspace-schedule` (reuse pola `profile-summary`/`site-build` queue): eksekusi prompt tersimpan dalam scope beku → kirim follow-up/notif; gagal 3x → mati + window berikutnya dibuka ulang (pola watermark profiling).
- Recipe: snapshot bounded artifact IDs + caption katalog (ikut bound `run-recipe.ts`, pola `CONTEXT7_TOOL_DEFINITIONS`); fail-closed bila ID tak bisa di-resolve (pesan terbaca, bukan chat rusak diam-diam).
- Events baru: `artifact_focus {artifactId, type}`, `artifact_created/updated {artifactId, type}` (pola `site_build_progress` + `publish()`).

### 4.6 Agent tools (final set, scoped)

`list_artifacts(type?, q?)`, `get_artifact(id)`, `find_images(q)`, `create_pdf_report`, `edit_pdf_report`, `snapshot_chart`, `use_image_in`, `list_sites` (ganti `by-session` sebagai default), `update_site_prompt` (via site-build yang ada, v+1), `manage_tasks` (create/update/list), `manage_schedules` (create/list/cancel), `list_sessions`, `get_session_excerpt`, `get_web_bundle`. Semua tool enforce `userId+sessionProjectId` di `execute` (defense in depth, bukan cuma di prompt). Instruksi: katalog dulu, detail on-demand, update pakai `id`, jangan tebak angka chart dari memori (pakai `analyze_dataset`/`create_chart` → `snapshot_chart` bila perlu gambar).

### 4.7 Clarification visual (extend, bukan duplikat)

- Extend `createQuestionTool` dengan `choice_type: text|artifact` + bila artifact wajib `artifact_type: image|site|document|task|session` + `artifactIds[]` kandidat (sudah scoped server-side).
- UI: `clarification-panel.tsx` di-extend: bila `artifact` render picker visual reuse `generated-image-thumbnail` / `document-row` / site preview thumb + `ManagementRow`; user juga bisa buka picker mandiri (tombol "pilih dari rak") tanpa menunggu agent. Validasi tetap: satu jawaban per pertanyaan; error field-spesifik; submit idempoten (pola `stageThenRespond` yang ada).

### 4.8 Frontend — pembagian peran + states

- **Left sidebar (navigasi):** sessions, projects, entry `Artifacts` (filter per scope aktif). Tidak ada preview berat di sini. States: loading skeleton list, empty ("belum ada artifact di scope ini"), error retry, success select. Reuse `session-history-list`, `projects-browser`, tambah `CountBadge` per tipe bila perlu (extend props, bukan komponen duplikat).
- **Chat room (center, aksi):** composer + `composerTopSlot` (site panel yang ada + report/task inline cards baru yang ringan) + `artifact_focus` highlight ("agent menunjuk X") + clarification picker. States: streaming (skeleton/shimmer yang ada), `artifact_focus` banner dismissible, error bubble dengan retry, success inline link ke artifact.
- **Right/kontekstual (inspeksi):** documents preview, image gallery + caption editor, site preview + versions/rollback, tasks/schedules panel, citations/sources. Buka sebagai modal/panel (`DialogShell size=lg`, `image-gallery-modal`, `document-preview-modal`, `site-build-panel` di-extend). States per panel: loading shimmer, empty illustration + CTA, error dengan pesan terbaca + retry, success toast/inline.
- **Baru (hanya bila belum ada — sudah dicek §2):** `artifacts-rail.tsx` (tab per tipe, reuse `ManagementRow`+`CountBadge`), `artifact-picker.tsx` (dipakai clarification + picker mandiri), `caption-field.tsx` (edit caption inline), `tasks-panel.tsx` + `schedules-panel.tsx` (reuse `ManagementRow` + `ConfirmDialog` untuk hapus). Warna/ikon lucide mengikuti yang ada; cek ketersediaan ikon saat implementasi, fallback netral. A11y: `role=switch/radiogroup/dialog`, `aria-checked/label`, fokus-trap + Esc via `DialogShell`.

### 4.9 Validation & errors

Zod ketat di router + tool input; caption 1–280 chars; artifact ID `SAFE_ID`/cuid; PDF markdown bound (ikut `run-recipe` bounds); chart spec validasi ulang server-side; schedule `freq` whitelist; semua error model-facing disanitasi (tanpa secret/SQL/stack); approval tetap via policy gate yang ada (bukan via clarification).

## 5. Out of scope (v1)

OAuth penuh/sso, share antar-user/kolaborasi real-time/komentar/activity log, kanban penuh, cron bebas, Puppeteer pixel-perfect, marketplace artifact publik, admin moderation, migrasi sites ke DB penuh, mobile offline. Semua dirancang agar bisa ditambah tanpa ubah kontrak §4.

## 6. Verification

- `pnpm --filter @anreal/api test`, `--filter @anreal/agent test`, `--filter @anreal/platform test` + `tsc --noEmit` + lint hijau; nol warning baru.
- Unit: scope matrix (standalone vs project X/Y), caption required/backfill, chart→snapshot→PDF embed, update-bukan-duplikat (site v+1, task status, report revisi), clarification artifact-type mapping.
- E2E real-LLM (wajib): model `muse-spark-1.3-contributor`, reasoning **medium/high**, tanpa stub untuk chat; image via stub/alternatif bila credits kurang. Cases: (1) PDF dari 2 dokumen + web bundle + 1 chart analisis, (2) reuse image lintas session via caption search ke PDF + site, (3) lanjutkan site dari session lain (cek v+1, bukan baru), (4) task+scheduler roundtrip, (5) clarification picker visual memilih image/site benar, (6) scope isolation negatif (standalone tidak melihat project, project A tidak melihat B).
- Anvia conformance: baca skill + `https://anvia.dev/llms.txt` + `https://github.com/anvia-hq/anvia` sebelum wiring tools/events/recipe; pakai pola resmi (progressive disclosure, frozen definitions, `close()` bila ada client).

## 7. Rollout (pragmatis, di plan)

1) Scope + caption + `list/get/find` → 2) chart snapshot + PDF create/edit → 3) site index migrasi + update lintas session → 4) tasks/schedules + worker → 5) `artifact_focus` + clarification visual + rails/panels → 6) E2E real-LLM + hardening.

## 8. Spec self-review

- Placeholder: tidak ada TBD/TODO; semua tipe, storage, dan tool final di §4.
- Konsistensi: scope rule §4.3 dipakai seragam di §4.5/4.6/4.8; update-semantik §4.6 cocok dengan versioning §4.4; clarification §4.7 memakai komponen §4.8.
- Scope: satu lapisan artifacts, bukan 3 proyek; dashboard ROI dan gateway broker eksplisit out (§5).
- Ambiguitas: "update vs baru" diputus (§4.6/4.4); "chart" diputus (spec JSON → snapshot PNG §4.5); "caption" diputus (wajib + auto-generate §4.4).

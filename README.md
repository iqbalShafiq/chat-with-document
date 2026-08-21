# Chat with Document

Monorepo aplikasi **AI chat** berbasis [Anvia](https://anvia.dev): UI React (`platform`), API Hono (`api`), dan package agent bersama (`@assingment/agent`). Percakapan tersimpan di Postgres lewat Prisma, streaming response ke client, serta tracing opsional ke Langfuse.

## Apa yang dibangun

Aplikasi chat full-stack di mana user bisa:

- Mengobrol dengan agent AI secara **streaming** (JSONL event stream)
- Mengelola **banyak session** (buat baru, ganti session, riwayat otomatis dari DB)
- Melihat **tool calls** di UI (misalnya statistik deskriptif, korelasi, regresi)
- Merender **Markdown + LaTeX math** (KaTeX) di pesan asisten
- Menyimpan memory percakapan per `sessionId` di Postgres (`@anvia/memory-prisma`)
- Melacak run agent di **Langfuse** (jika kredensial diisi)
- **Generate & edit gambar** lewat agent (`generate_image`/`edit_image`) dengan galeri per session dan per proyek
- Memberi **persetujuan tool** (sekali / per session) dan menjawab **wizard klarifikasi** agent

## Arsitektur

```
┌─────────────────┐     HTTP / JSONL      ┌─────────────────┐
│  platform       │ ───────────────────►  │  api (Hono)     │
│  React + Anvia  │  /api/chat            │  chat router    │
│  :3000          │ ◄───────────────────  │  :3001          │
└─────────────────┘     stream events     └────────┬────────┘
                                                   │
                                   ┌───────────────┼───────────────┐
                                   ▼               ▼               ▼
                          @assingment/agent   Prisma memory    Langfuse
                          (OpenAI + tools)    (Postgres)       (tracing)
```

Alur singkat:

1. UI mengirim `POST /api/chat` dengan `sessionId` + pesan terakhir.
2. API membuat agent lewat `createAgent()`, memasang memory Prisma + tools analisis data.
3. Agent memanggil model OpenAI, boleh memakai tools, lalu stream event ke client.
4. Memory session/message tersimpan di Postgres; UI bisa `GET` pesan lama saat ganti session.

## Fitur utama

| Area | Detail |
| --- | --- |
| Chat streaming | `@anvia/react` + `@anvia/server` (`createEventStream`, format `jsonl`) |
| Queued follow-ups | Kirim pesan saat streaming — antrean per session (localStorage), `PromptRequest.steer()` ke run aktif (1 pesan/turn FIFO), auto-flush saat idle, hold setelah stop/error, edit + drag reorder, persist lintas reload |
| Multi-session | Session ID di `localStorage`; daftar session dari DB |
| Agent tools | `descriptive_stats`, `pearson_correlation`, `linear_regression` |
| Image generation | `generate_image`/`edit_image`, katalog model image, galeri session + proyek, background transparan |
| Human approval | Policy consent gate (web + image tools) + `request_clarification` wizard |
| Model registry | Katalog model text/image via `chat_model` (`outputType`/`imageCapabilities`), seed idempotent |
| Math rendering | `react-markdown` + `remark-math` + `rehype-katex` |
| Memory | Model `AgentMemorySession` / `AgentMemoryMessage` / `AgentMemoryError` |
| Observability | Langfuse via `@anvia/langfuse` |

## Stack

| Layer | Tech |
| --- | --- |
| Frontend | React 19, Vite 8, TanStack Router, Tailwind CSS 4, `@anvia/react` ^0.11.6 + `@anvia/react-ui` ^0.7.1, KaTeX |
| API | Hono, `@hono/node-server`, Prisma 7 + Postgres (`@prisma/adapter-pg`), `@anvia/server` ^0.7.6, `@anvia/memory-prisma` ^0.3.1 |
| Agent | `@anvia/core` ^0.26.0 (v0 line), `@anvia/openai` ^0.5.1, `@anvia/mistral` ^0.4.1, `@anvia/qdrant` ^0.4.0, Langfuse, Zod |
| Tooling | pnpm workspaces, Docker Compose (Postgres 16) |

## Struktur monorepo

```
apps/
  api/                 # Hono API — chat endpoints + Prisma
    prisma/            # schema + migrations
    src/
      modules/chat/    # GET/POST /api/chat, GET /api/chat/sessions
      generated/       # Prisma client (gitignored)
  platform/            # Vite React chat UI (port 3000)
    src/
      routes/          # halaman chat utama
      components/      # MathMarkdown, dll.
packages/
  agent/               # Shared agent factory, prompts, providers, tools, tracing
docker-compose.yml     # Postgres lokal di port 15433
.env.example
```

### Package `@assingment/agent`

Factory agent yang dipakai API:

- `createAgent()` — `AgentBuilder` + base instructions + optional tools/memory/tracing
- `createDataAnalysisTool()` — tiga tool statistik numerik
- `tracing` — instance Langfuse dari env
- Default model: OpenAI via OpenRouter Responses API (`openai/gpt-5.6-luna`), konfigurasi via `OPENAI_*`

## Prerequisites

- **Node.js** 22+
- **[pnpm](https://pnpm.io/)** 10 (`packageManager` dipin ke `pnpm@10.30.3`)
- **Docker** (untuk Postgres lokal)
- API key OpenAI (atau provider yang kompatibel dengan `OPENAI_BASE_URL`)

## Setup

1. **Install dependencies**

   ```bash
   pnpm install
   ```

2. **Environment**

   ```bash
   cp .env.example .env
   ```

   Isi nilai di root `.env`:

   | Variable | Purpose |
   | --- | --- |
   | `OPENAI_BASE_URL` / `OPENAI_API_KEY` | LLM provider — dipakai untuk chat **dan** image generation (tidak ada key baru) |
   | `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Observability (opsional) |
   | `TAVILY_API_KEY` | API key Tavily untuk tool `web_search`/`web_fetch` (wajib untuk web search) |
   | `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` | Cloudflare R2 (S3-compatible) untuk penyimpanan gambar generated (wajib untuk image generation) |
   | `CONTEXT7_API_KEY` | API key context7 untuk tool dokumentasi library/API (opsional; gratis di context7.com/dashboard) |
   | `CONTEXT7_URL` | Endpoint MCP context7 (default `https://mcp.context7.com/mcp`) |
   | `DATABASE_URL` | Koneksi Postgres (default cocok dengan Docker Compose) |
   | `BETTER_AUTH_SECRET` | Secret cookie session (wajib; `openssl rand -base64 32`) |
   | `BETTER_AUTH_URL` | Base URL API auth (default `http://localhost:3001`) |
   | `PLATFORM_ORIGIN` | Origin frontend web untuk CORS + trustedOrigins (default `http://localhost:3000`) |
   | `TRUSTED_ORIGINS` | Origin tambahan (comma-separated) yang boleh memanggil API dari browser / webview — Expo web, preview, custom scheme mobile, dll. Native HTTP client biasanya tidak mengirim `Origin` |
   | `PORT` | Port API (default `3001`) |
   | `NODE_ENV` | Environment untuk Langfuse (`development`, dll.) |
   | `PROFILE_ENABLED` | Master toggle for user profiling (default `true`) |
   | `PROFILE_REFRESH_DELAY_MINUTES` | Debounce window for background profile refresh (default `15`) |
   | `PROFILE_WORKER_CONCURRENCY` | Parallel profile summary workers (default `3`) |
   | `PROFILE_SUMMARY_MODEL` | Summarizer model; defaults to the chat default (`openai/gpt-5.6-luna`) |

3. **Start Postgres**

   ```bash
   docker compose up -d
   ```

   Default URL: `postgresql://postgres:postgres@localhost:15433/postgres`

4. **Database**

   ```bash
   pnpm --filter api db:generate
   pnpm --filter api db:migrate
   ```

## Development

Dari root repo, jalankan API dan platform bersamaan:

```bash
pnpm dev
```

| App | URL |
| --- | --- |
| Platform (chat UI) | `http://localhost:3000` and `http://<lan-ip>:3000` |
| API | `http://localhost:3001` and `http://<lan-ip>:3001` |
| API docs (Scalar) | http://localhost:3001/scalar |
| OpenAPI document | http://localhost:3001/doc |

`pnpm dev` listen di **semua interface** (`0.0.0.0`), jadi HP di Wi-Fi yang sama bisa buka `http://192.168.x.x:3000` (UI) atau `http://192.168.x.x:3001` (API / Scalar). Vite mencetak baris **Network**; API mencetak setiap IP LAN di log.

Kalau Windows Firewall prompt muncul, izinkan Node.js di **Private** network. Set `HOST=127.0.0.1` di `.env` kalau ingin kembali ke localhost saja.

Apps memuat env dari root `.env` lewat `dotenv-cli` (script `with-env`).

### Useful scripts

```bash
# API only
pnpm --filter api dev

# Platform only
pnpm --filter platform dev

# Prisma
pnpm --filter api db:generate   # regenerate client → apps/api/src/generated
pnpm --filter api db:migrate    # migrate (dev)
pnpm --filter api db:deploy     # migrate (deploy)
pnpm --filter api db:studio     # Prisma Studio

# API smoke (register → login → chat + usage audit); API must be running
pnpm --filter api smoke:auth
```

### E2E (Playwright)

```bash
pnpm --filter platform exec playwright test
```

Suite browser (8 test) di `apps/platform/e2e/` menguji alur image generation end-to-end terhadap stub LLM lokal. Prasyarat:

- **Docker up** (Postgres/Redis — `docker compose up -d`), DB sudah migrasi.
- **Port 3000 / 3001 / 18765 bebas** — Playwright me-boot stub (port **18765**) + dev stack sendiri via `webServer`; kill proses stray dulu (`lsof -i :3000 -i :3001 -i :18765`).
- **Node ≥ 22.18** — stub dijalankan langsung (`node e2e/stub-openrouter.ts`) dengan type-stripping bawaan Node.
- **Jangan menjalankan dev server dengan real keys** — stub menolak jika shell mengekspor `OPENAI_BASE_URL` selain URL stub; jalankan tanpa env provider di shell.

Auth e2e dibuat otomatis di `globalSetup` (sign-up user baru + cookie session).

E2E **LLM asli** (OpenRouter dari `.env`, browser headed, tanpa stub):

```bash
# API :3001 + platform :3000 sudah `pnpm dev` dengan key real
pnpm --filter platform exec -- playwright test --config playwright.real-llm.config.ts
```

Jangan campur dengan suite stub: suite stub menolak `OPENAI_BASE_URL` selain `:18765`.

## Authentication

- Email/password via **Better Auth** (`/api/auth/*`).
- **Web platform** memakai HTTP-only cookie session (`credentials: include`).
- **Mobile / extra-repo clients** memakai Bearer token:
  1. `POST /api/auth/sign-in/email` (atau sign-up)
  2. Baca header respons `set-auth-token`
  3. Simpan di secure storage
  4. Kirim `Authorization: Bearer <token>` di setiap request
- Cookie dan Bearer setara — `requireUser` memakai `auth.api.getSession({ headers })`, yang menerima keduanya.
- Browser client harus mengirim `Origin` yang ada di `PLATFORM_ORIGIN`, origin API itu sendiri (agar Scalar "Try it" jalan), atau `TRUSTED_ORIGINS`.
- Platform routes `/login` and `/register`; chat (`/`) requires a session.
- Chat memory di-scope Anvia dengan `userId`: `scopeKey = [sessionId, userId]`.
- Documents **owned by user** (no sharing). Storage quota **200MB per user** (`GET /api/documents/storage`).
- Setiap chat agent run menulis `AgentUsageEvent` (token counts dari Anvia `Usage`; cost USD hanya jika provider mengirim cost — biasanya `null` di OpenAI).

## OpenAPI / Scalar

Dokumentasi interaktif memakai [Scalar](https://scalar.com/products/api-references/integrations/hono) (integrasi resmi Hono):

| URL | Isi |
| --- | --- |
| http://localhost:3001/scalar | UI Scalar (auth Bearer di panel Authenticate) |
| http://localhost:3001/doc | OpenAPI 3.1 JSON |
| http://localhost:3001/openapi.json | Alias dokumen yang sama |
| http://localhost:3001/health | Liveness (tanpa auth) |

Setiap operation punya deskripsi, status sukses + error, dan contoh request/response. Spec ini yang dipakai mobile client / generator SDK.

Contoh sign-in + panggilan terautentikasi dari luar repo:

```bash
# 1. Sign in
curl -D - -X POST http://localhost:3001/api/auth/sign-in/email \
  -H "content-type: application/json" \
  -H "origin: http://localhost:3000" \
  -d '{"email":"ada@example.com","password":"correct-horse-battery"}'

# 2. Salin header set-auth-token, lalu:
curl http://localhost:3001/api/chat/sessions \
  -H "authorization: Bearer <token>"
```

Native mobile (React Native / Flutter / Kotlin / Swift) tidak terkena CORS. Webview / Expo web harus ditambahkan ke `TRUSTED_ORIGINS`.

## API chat

Base path: `/api/chat` (semua endpoint **require auth cookie**)

| Method | Path | Keterangan |
| --- | --- | --- |
| `GET` | `/api/chat/sessions` | Daftar session milik user (urut `updatedAt` desc) |
| `GET` | `/api/chat?sessionId=...` | Load history messages untuk session user |
| `POST` | `/api/chat` | Kirim pesan; response **streaming** JSONL |
| `POST` | `/api/chat/steer` | Queue follow-up ke run aktif (`{ sessionId, messages[] }`); worker meng-inject via `PromptRequest.steer()` 1/turn; `409 NO_ACTIVE_RUN` saat idle |
| `POST` | `/api/chat/queue/sync` | Dedupe antrean lintas reload: `{ sessionId, ids[] }` → `{ appliedIds[] }` (id yang sudah masuk memory) |
| `POST` | `/api/chat/approvals/:approvalId/decision` | Putusan approval card: `approved` (bool), opsional `grantScope` (`"session"` = Allow for session), `reason`, dan `overrideArgs` (arg tool yang diedit user, mis. param gambar) |
| `POST` | `/api/chat/clarifications/:id/response` | Jawaban wizard klarifikasi: `answers` (object `string \| string[]`) + opsional `skipped` (string[]) |
| `GET` | `/api/chat/capabilities` | Ketersediaan fitur: `webSearchAvailable`, `imageGenerationAvailable`, `context7Available` |

Body `POST` (ringkas):

```json
{
  "sessionId": "<uuid>",
  "messages": [ /* core messages dari @anvia/react */ ],
  "stream": true
}
```

`sessionId` wajib (bisa juga dari `metadata.sessionId`). Tanpa auth → `401`. Tanpa `sessionId` → `400`.

### API images

Base path: `/api/images` (semua endpoint **require auth cookie**, kepemilikan user di-enforce)

| Method | Path | Keterangan |
| --- | --- | --- |
| `GET` | `/api/images?sessionId=...` | Galeri per session (milik user) |
| `GET` | `/api/images?projectId=...` | Galeri per proyek (milik user/member proyek) |
| `GET` | `/api/images?scope=user` | Semua gambar milik user |
| `GET` | `/api/images/:id` | Serve binary gambar dari R2 (ownership check; `404`/`403` jika tidak berhak) |

Metadata gambar tidak pernah mengekspos `r2Key`. Regenerasi/truncate session otomatis me-refresh galeri.

## Agent tools

Tools ini di-inject ke agent saat handle chat:

| Tool | Fungsi |
| --- | --- |
| `descriptive_stats` | count, mean, median, mode, min/max, range, quartiles, IQR, variance, stdDev, skewness |
| `pearson_correlation` | korelasi Pearson, covariance, arah, kekuatan, R² |
| `linear_regression` | regresi sederhana `y = slope * x + intercept`, residual, prediksi opsional |
| `web_search` | Cari web (Tavily) — butuh persetujuan saat toggle off; kini juga `images[]` |
| `web_fetch` | Ambil isi halaman web tertentu (Tavily) — kini juga `images[]` |
| `view_image` | Lihat gambar dari `web_search`/`web_fetch` `images[]` atau `imageId` session/dokumen — vision: bytes, text-only: deskripsi (via vision helper) |
| `generate_image` | Generate gambar dari prompt; param (model, aspect ratio, quality, background) hanya diisi saat user minta, selainnya pakai default session |
| `edit_image` | Edit gambar generated sebelumnya (via `referenceImageId`) — dikirim sebagai `input_references` (data URL) |
| `request_clarification` | Tanya user saat request ambigu (max 5 pertanyaan, tipe single/multiple choice/free text) |

Contoh prompt: *“Hitung mean dan standar deviasi dari [12, 15, 18, 20, 22]”* — agent akan memanggil `descriptive_stats`.

### Web search

Web search aktif per-session lewat toggle di composer (ikon globe, tanpa label, default **off**). Saat toggle off, agent tetap bisa memanggil tool web lalu *suspend* dan meminta persetujuan user via *glass approval card* dengan alasan dinamis yang dihasilkan agent — user bisa **Allow once**, **Allow for session**, atau **Reject**. Sumber web yang dikumpulkan dari pencarian tampil di sidebar kanan (bagian **Web sources**). Tool web hanya terdaftar jika `TAVILY_API_KEY` diisi (toggle nonaktif jika kosong). Dokumentasi library/API via MCP context7 (`resolve-library-id`, `query-docs`) opsional dengan `CONTEXT7_API_KEY`.

- `web_search` kini mengembalikan `images[]` (`{ url, description }`, max 5, deskripsi truncate 300 chars) dari Tavily `includeImages`+`includeImageDescriptions`; `web_fetch` mengembalikan `images[]` (string URLs, max 5) dari `extract` `includeImages`.
- `view_image` universal: model vision menerima **image bytes** (`ToolResultContent` `{type:"image", data:base64, mediaType}`), model text-only menerima **deskripsi** via cheap vision helper model (sub-agent-as-tool). Pass `url` dari `web_search`/`web_fetch` `images[]` ke `view_image(url)` — lihat `docs/superpowers/specs/2026-08-19-web-search-image-view-design.md`.

### Image generation

Agent dapat generate dan edit gambar lewat tool `generate_image`/`edit_image` (lihat tabel tool di atas):

| Aspek | Detail |
| --- | --- |
| Model | Katalog image dari model registry — `openai/gpt-5-image-mini` (**default**), `google/gemini-3.1-flash-lite-image`, `x-ai/grok-imagine-image-quality`; dipilih per session di composer |
| Env | Tidak ada key baru — reuse `OPENAI_BASE_URL` / `OPENAI_API_KEY` (endpoint `/api/v1/images` OpenRouter) |
| Persetujuan | Toggle per-session di composer; saat off, run *suspend* dan minta persetujuan (Allow once / Allow for session / Reject) |
| Klarifikasi | Saat request ambigu (style, aspect ratio, subjek), agent memanggil `request_clarification` — UI menampilkan **wizard** multi-pertanyaan, jawaban dipetakan kembali ke agent |
| Galeri | Right rail per session (gambar hasil regenerasi/truncate ikut ter-refresh) + sidebar kiri **Images** (modal galeri lintas chat dengan filter proyek) |
| Background remover | Opsi background `transparent` di editor param gambar — hanya tersedia untuk model OpenAI (`gpt-5-image-mini`) yang mendukung `background: transparent`; output dikirim sebagai `output_format: png` |
| Edit | `edit_image` mereferensikan gambar hasil generate sebelumnya (`referenceImageId`) dan mengirimnya sebagai `input_references` data URL |
| Penyimpanan | **1 gambar = 1 generate** — setiap gambar disimpan sebagai 1 baris `GeneratedImage` + objek R2 (ada cap `n` per model di katalog) |

### Human approval & clarification

Kontrol user atas aksi agent memakai **dua lapis**:

1. **Policy consent gate** — untuk tool yang "berisiko" (`web_search`, `web_fetch`, `generate_image`, `edit_image`). Saat toggle fitur off dan belum ada grant, panggilan tool men-suspend run dan memunculkan *glass approval card* (alasan dinamis dari agent) dengan tombol **Allow once**, **Allow for session**, dan **Reject**. "Allow for session" menulis grant Redis sehingga gate dilewati untuk sisa session; arg tool yang diedit user (mis. prompt/aspect ratio di kartu approval) di-stage sebagai override yang dikonsumsi sekali (atomik).
2. **Generic `request_clarification` tool** — untuk request ambigu, bukan permission. Agent bisa menanyakan hingga 5 pertanyaan (single choice / multiple choice / free text) lewat wizard; user bisa skip pertanyaan opsional, dan jawaban dipetakan kembali ke agent.

Status disimpan di Redis:

| Key | Fungsi |
| --- | --- |
| `chat-tool-grant:<sessionId>:<toolName>` | Grant "Allow for session" untuk tool |
| `chat-tool-override:<sessionId>:<toolName>` | Override arg tool satu-kali (dari kartu approval) |
| `chat-clarification:<id>` (+ `:decision`) | Rekam permintaan klarifikasi + jawabannya |

Response yang terlambat (approval/klarifikasi sudah resolved atau TTL) bersifat idempoten — endpoint mengembalikan `{ ok: true, alreadyResolved: true }`, tidak error.

### Model registry

Katalog model ada di tabel `chat_model` (diseed oleh `pnpm --filter api db:seed` — **idempotent**, run ulang menghasilkan `created=0 updated=0 removed=0`):

| Kolom | Keterangan |
| --- | --- |
| `outputType` | `"text"` (default) atau `"image"`; model image tidak punya reasoning efforts |
| `imageCapabilities` | JSONB — `quality`, `background`, `n` (min/max), `aspectRatios`/`resolutions` sesuai model |
| harga, `iconSvg`, dll. | Metadata katalog untuk UI pemilih model |

`GET /api/models` menyajikan katalog ke UI; seed melakukan **upsert** per model (created/updated dihitung, tidak ada duplikat).

## User profiling

- Per-user (all chats) and per-project profiles are summarized in the background
  (BullMQ `profile-summary` queue) from user messages only — tool calls and
  assistant replies are excluded.
- Profiles are injected into every chat as context blocks (`user_profile`,
  `project_profile`); policy lives in agent instructions.
- The agent can persist explicit facts immediately via `remember_user_profile`
  when the user says "remember…".
- View/reset profiles in Settings → Personalization (`GET`/`DELETE /api/profiling`).
- Failed summary jobs are not retried forever: after `attempts: 3` the job dies
  and the next chat re-opens a refresh window (watermark-derived delta keeps
  nothing lost).

## Frontend notes

- Endpoint API di UI mengikuti hostname halaman (localhost → `:3001`, `192.168.x.x` → `http://192.168.x.x:3001`). Override lewat `VITE_API_BASE`.
- Session aktif disimpan di `localStorage` (`chat.sessionId`).
- Pesan asisten dirender lewat `MathMarkdown`: normalisasi delimiter LaTeX umum (`\[...\]`, `\(...\)`, `[ \frac{...} ]`) lalu KaTeX.

## Notes

- Prisma Client di-generate ke `apps/api/src/generated/prisma` (gitignored). Jalankan `db:generate` setelah clone atau ubah schema.
- Chat memory memakai `@anvia/memory-prisma` terhadap model `AgentMemory*` di `apps/api/prisma/schema.prisma`.
- CORS di API mengizinkan `PLATFORM_ORIGIN`, origin API (Scalar), dan `TRUSTED_ORIGINS`. Native mobile tidak terkena CORS.
- Tanpa `OPENAI_API_KEY` yang valid, stream chat akan gagal di sisi agent.
- Langfuse opsional: kosongkan `LANGFUSE_*` jika tidak dipakai (pastikan tracing tidak memblok request di setup Anda).
- Anvia tetap di kereta **v0** (`@anvia/core@0.26.x` + adapter yang matching). Dokumentasi resmi sudah menunjuk v1 (`1.0.0-rc.x`, `new Agent` tanpa `AgentBuilder`); rewrite itu belum diterapkan di app ini.
- Compaction resmi `@anvia/memory-prisma` (hapus prefix baris) **tidak** dinyalakan. Compaction session tetap app-layer di `AgentMemorySession.metadata.compaction`.
- **`@anvia/react-ui` di-patch** (`patches/@anvia__react-ui.patch`, via `pnpm.patchedDependencies`): editor composer dibuat tetap editable + submittable saat streaming (SDK 0.7.1 masih mengunci `contenteditable` dan `canSubmit` selama streaming). Fitur queue follow-up bergantung pada patch ini; saat upgrade `@anvia/react-ui`, patch harus dicek ulang.
- Antrean follow-up per session disimpan di `localStorage` (`chat.queue.<sessionId>`); event stream `queued_message_applied` adalah ack dari worker saat pesan steered masuk ke run.

## Troubleshooting singkat

| Masalah | Cek |
| --- | --- |
| API tidak connect ke DB | `docker compose ps`, pastikan port `15433`, cocokkan `DATABASE_URL` |
| Prisma error setelah pull | `pnpm --filter api db:generate` lalu `db:migrate` |
| UI kosong / CORS | Pastikan API jalan di `:3001` dan `pnpm --filter api dev` |
| Math tidak ter-render | Pastikan asisten memakai `$...$` / `$$...$$` (instruksi ada di base prompt) |

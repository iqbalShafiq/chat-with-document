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
| Multi-session | Session ID di `localStorage`; daftar session dari DB |
| Agent tools | `descriptive_stats`, `pearson_correlation`, `linear_regression` |
| Math rendering | `react-markdown` + `remark-math` + `rehype-katex` |
| Memory | Model `AgentMemorySession` / `AgentMemoryMessage` / `AgentMemoryError` |
| Observability | Langfuse via `@anvia/langfuse` |

## Stack

| Layer | Tech |
| --- | --- |
| Frontend | React 19, Vite 8, TanStack Router, Tailwind CSS 4, `@anvia/react` + `@anvia/react-ui`, KaTeX |
| API | Hono, `@hono/node-server`, Prisma 7 + Postgres (`@prisma/adapter-pg`) |
| Agent | `@anvia/core`, `@anvia/openai`, Langfuse, Zod |
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
- Default model: OpenAI Responses API (`gpt-5.6-luna`), konfigurasi via `OPENAI_*`

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
   | `OPENAI_BASE_URL` / `OPENAI_API_KEY` | LLM provider (wajib untuk chat) |
   | `LANGFUSE_BASE_URL` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | Observability (opsional) |
   | `DATABASE_URL` | Koneksi Postgres (default cocok dengan Docker Compose) |
   | `PORT` | Port API (default `3001`) |
   | `NODE_ENV` | Environment untuk Langfuse (`development`, dll.) |

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
| Platform (chat UI) | http://localhost:3000 |
| API | http://localhost:3001 |

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
```

## API chat

Base path: `/api/chat`

| Method | Path | Keterangan |
| --- | --- | --- |
| `GET` | `/api/chat/sessions` | Daftar `sessionId` unik (urut `updatedAt` desc) |
| `GET` | `/api/chat?sessionId=...` | Load history messages untuk session |
| `POST` | `/api/chat` | Kirim pesan; response **streaming** JSONL |

Body `POST` (ringkas):

```json
{
  "sessionId": "<uuid>",
  "messages": [ /* core messages dari @anvia/react */ ],
  "stream": true
}
```

`sessionId` wajib (bisa juga dari `metadata.sessionId`). Tanpa itu API mengembalikan `400`.

## Agent tools (data analysis)

Tools ini di-inject ke agent saat handle chat:

| Tool | Fungsi |
| --- | --- |
| `descriptive_stats` | count, mean, median, mode, min/max, range, quartiles, IQR, variance, stdDev, skewness |
| `pearson_correlation` | korelasi Pearson, covariance, arah, kekuatan, R² |
| `linear_regression` | regresi sederhana `y = slope * x + intercept`, residual, prediksi opsional |

Contoh prompt: *“Hitung mean dan standar deviasi dari [12, 15, 18, 20, 22]”* — agent akan memanggil `descriptive_stats`.

## Frontend notes

- Endpoint chat di UI di-hardcode ke `http://localhost:3001` (lihat `apps/platform/src/routes/index.tsx`).
- Session aktif disimpan di `localStorage` (`chat.sessionId`).
- Pesan asisten dirender lewat `MathMarkdown`: normalisasi delimiter LaTeX umum (`\[...\]`, `\(...\)`, `[ \frac{...} ]`) lalu KaTeX.

## Notes

- Prisma Client di-generate ke `apps/api/src/generated/prisma` (gitignored). Jalankan `db:generate` setelah clone atau ubah schema.
- Chat memory memakai `@anvia/memory-prisma` terhadap model `AgentMemory*` di `apps/api/prisma/schema.prisma`.
- CORS di API diaktifkan agar Vite di `:3000` bisa memanggil `:3001`.
- Tanpa `OPENAI_API_KEY` yang valid, stream chat akan gagal di sisi agent.
- Langfuse opsional: kosongkan `LANGFUSE_*` jika tidak dipakai (pastikan tracing tidak memblok request di setup Anda).

## Troubleshooting singkat

| Masalah | Cek |
| --- | --- |
| API tidak connect ke DB | `docker compose ps`, pastikan port `15433`, cocokkan `DATABASE_URL` |
| Prisma error setelah pull | `pnpm --filter api db:generate` lalu `db:migrate` |
| UI kosong / CORS | Pastikan API jalan di `:3001` dan `pnpm --filter api dev` |
| Math tidak ter-render | Pastikan asisten memakai `$...$` / `$$...$$` (instruksi ada di base prompt) |

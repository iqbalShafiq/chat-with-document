# Data Analysis (tabular) + Deep Research — Design

Date: 2026-08-21

## 1. Goal

Turn the app from "chat over documents" into "chat over documents **and data**" with two capabilities:

1. **v1 — Tabular data analysis** (user-facing core):
   - Upload **CSV / XLSX** as documents (reusing the existing document pipeline, ownership, session-linking, quota).
   - Extract tables from **existing PDF/image documents** (OCR already emits markdown tables).
   - Analyze datasets via **deterministic operations** (`analyze_dataset`) and **read-only in-process SQL** (`query_dataset_sql` via sql.js / SQLite WASM).
   - Render results as **tables and charts that flow naturally in the middle of the chat** (inside tool-result cards, like `ToolResultImages` today).
2. **Fase 2 — Deep research** (implicit, approval-gated):
   - A per-session "Deep research" feature (like Web search / Image generator). When **on**, the agent may call `deep_research` freely; when **off**, the agent may still decide it needs deep research and **ask for approval** (Allow once / Allow for session / Reject) via the existing glass approval card.
   - Internally a **researcher sub-agent** (`Agent.asTool`) runs plan → search (docs + web) → analyze → synthesize → verify, producing a structured, cited markdown report.

## 2. Strategy

- **CSV/XLSX are documents.** They flow through the exact same `Document` lifecycle (`queued → uploading → … → ready | failed`), are linked per session, counted against the 200 MB quota, and appear in the document library/catalog. Only the *ingest* step differs: tabular files get a **text/table parse branch** (no OCR) that stores a structured dataset.
- **One dataset contract for all sources.** CSV/XLSX sheets and PDF-extracted markdown tables are normalized into the same `TabularSheet` shape (`{ name, columns[], rows[] }`). The agent references a dataset by a `DatasetRef` (`{ documentId, sheet? }` for uploads, `{ documentId, pageIndex, tableIndex }` for extracted tables). All analysis tools consume this one contract.
- **No code execution.** Analysis is (a) deterministic pure functions (safe, testable, no infra) plus (b) **read-only SQL via sql.js (SQLite compiled to WASM)** — real analytical SQL in-process, without a Python sandbox or native builds. Python sandbox is explicitly **out of scope** (no Python runtime in the stack, security surface, ops burden; revisit only if users hit hard walls). (Engine note: native `duckdb` was evaluated first but dropped — prebuilt binaries failed to download in this environment and node-pre-gyp fell back to a multi-hour MSVC source build; sql.js delivers the same product value.)
- **Charts ride on tool output.** The Anvia v0.26 UI stream (`UIStreamEvent`) only supports 6 event types and `ToolResultContent` is text/image only. So a chart is a **JSON `ChartSpec` inside the tool result** (`part.output`), rendered by new `DataChart`/`DataTable` components in the tool-result card. No streaming changes.
- **Deep research is one approval-gated tool** on the main agent, whose body is a bounded researcher sub-agent (`agent.asTool()`), not a swarm of per-step agents. The main data-analysis tools stay registered on the main agent too.

## Phasing

This spec intentionally covers **v1 (tabular data analysis)** and **fase 2 (deep research)** as one design document because fase 2 depends on v1's table/chart/tool foundation. They are **implemented and planned separately**:

- **Plan 1 — v1**: sections 3, 4, 6, 7, 8 (v1 parts), 10 — CSV/XLSX + PDF-table analysis + charts.
- **Plan 2 — fase 2**: section 5 — the approval-gated `deep_research` researcher sub-agent.

v1 must land first; fase 2 reuses its components without rework.

## 3. v1 — Backend (`apps/api` + `packages/agent`)

### 3.1 Schema — `Document`

```prisma
model Document {
  ...
  mimeType     String
  ...
  /// Structured tabular data for CSV/XLSX files: { sheets: TabularSheet[] }.
  tabularData  Json?
  ...
}
```

- Nullable `tabularData` — set only for tabular files, at ingest time.
- No new table, no `fileKind`: tabular is inferred from `mimeType` (`text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`).
- Migration + regen (`pnpm --filter api db:generate`).

### 3.2 Upload allowlist

`apps/api/src/modules/documents/service.ts` (allowlist at :13-18, checks at :156-161):

- Add `text/csv` and `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
- Keep 10 MB/file + 200 MB/user caps. Add `MAX_TABULAR_ROWS` (default 50_000) and `MAX_TABULAR_COLUMNS` (default 100) enforced at parse time → upload becomes `failed` with a clear `errorMessage` ("too many rows", "no data", "no header").

### 3.3 Ingest — tabular parse branch

`apps/api/src/worker.ts` `processDocumentIngest` (:41-177): before the OCR path, MIME-dispatch:

- `text/csv` / xlsx → `parseTabularFile(bytes, mimeType, filename)` (see 3.4).
  - Build one synthetic `DocumentPage` (pageIndex 0): `rawMarkdown` = the first sheet as a GFM markdown table (human preview), `summary` = first lines.
  - Set `Document.pageCount = 1`, `Document.tabularData = { sheets }`.
  - **Still chunk + embed** the markdown table into Qdrant (so semantic search can find the dataset) — reuse the existing chunk/embed path, then `status: "ready"`.
- Parse/validation errors → `status: "failed"` + `errorMessage`.

### 3.4 `packages/agent/src/tools/tabular/` (new module, pure + testable)

| File | Responsibility |
| --- | --- |
| `types.ts` | `CellValue`, `ColumnType` (`"number"\|"string"\|"boolean"\|"date"\|"null"`), `TabularColumn {name,type}`, `TabularSheet {name, columns, rows}`, `DatasetRef` union (`{type:"upload", documentId, sheet?}` \| `{type:"document_table", documentId, pageIndex, tableIndex}`) |
| `parse-csv.ts` | RFC 4180 parser: quoted fields, embedded commas/newlines, CRLF, BOM strip, header detection, per-column type inference |
| `parse-xlsx.ts` | `read-excel-file` (MIT, read-only) → all sheets to `TabularSheet[]`; type inference shared with CSV |
| `markdown-tables.ts` | Extract GFM markdown tables from `DocumentPage.rawMarkdown` → `TabularSheet[]` (per page, indexed) |
| `tabular-analysis.ts` | Pure ops: `profile`, `aggregate`/`group_by`, `filter`, `sort`, `top_n`, `correlation`, `trend` + `ChartSpec` builders |
| `sql.ts` | sql.js (SQLite WASM) runner: register dataset → run **SELECT-only** query, row cap |

Dependency: `read-excel-file` (xlsx) and `sql.js` (SQLite WASM — pure WASM, no native build). CSV stays dependency-free (small, fully unit-tested RFC 4180 parser).

### 3.5 Tools (registered on the main agent, like `createDataAnalysisTools()`)

New `createTabularAnalysisTools()` in `packages/agent/src/tools/tabular-analysis.ts` (or extend `data-analysis.ts`), wired in `build-run-input.ts` (:371-375). Backed by a `DatasetResolver` injected with `prisma` + R2 (reads `Document.tabularData` or parses page markdown on demand).

1. **`read_dataset`** — `{ source: DatasetRef }` → `{ name, rowCount, columns:[{name,type}], preview: rows[0..10] }`. Lets the agent "meet" the data before asking questions.
2. **`analyze_dataset`** — `{ source, operation, ... }`:
   - `profile`: per-column stats (numeric: count/nonNull/mean/min/max/stdDev/q1/q3; categorical: unique, top values + frequency). Optionally a chart (histogram for numeric, bar for categorical).
   - `aggregate`: `groupBy: string[]` + `metrics: [{column, fn: sum|mean|count|min|max|median}]` → table + optional bar/line chart.
   - `filter`: `{ column, op: eq|neq|gt|gte|lt|lte|contains, value }` → filtered table (capped) + optional histogram.
   - `sort`: `{ column, order: asc|desc }` → table (capped).
   - `top_n`: `{ column, n }` → table + bar chart.
   - `correlation`: `{ x, y }` → reuse the existing Pearson logic (`data-analysis.ts`) → `{ n, correlation, direction, strength, rSquared }` + scatter chart (with optional linear-fit line).
   - `trend`: `{ x, y }` → sorted series + line chart.
   - Returns `{ operation, summary, result?: { columns, rows, rowCount, truncated }, chart?: ChartSpec }`.
3. **`query_dataset_sql`** — `{ source, query }` → sql.js (SQLite WASM) **read-only**: only `SELECT`/`WITH … SELECT` (reject DDL/DML/multi-statement), in-memory, row cap (default 500), returns `{ columns, rows, rowCount, truncated }`. No chart (agent uses `analyze_dataset` when a chart is wanted).
4. **`extract_document_tables`** — `{ documentId? }` (optional; default: all linked ready docs) → scans `DocumentPage.rawMarkdown` of ready linked documents, returns discovered `{ documentId, filename, pageIndex, tableIndex, columns, rowCount, preview }[]` so the agent can feed those to `read_dataset`/`analyze_dataset`.

### 3.6 Chart spec contract (shared)

`packages/agent/src/tools/tabular/chart-spec.ts`:

```ts
type ChartSpec =
  | { kind: "bar";       labels: string[]; series: { name: string; values: number[] }[]; xLabel?: string; yLabel?: string }
  | { kind: "line";      labels: string[]; series: { name: string; values: number[] }[]; xLabel?: string; yLabel?: string }
  | { kind: "scatter";   points: { x: number; y: number }[]; xLabel?: string; yLabel?: string }
  | { kind: "histogram"; bins: { min: number; max: number; count: number }[]; label?: string };
```

Source of truth on the agent side. The platform mirrors minimal DTOs + a `parseChartSpec` validator in `apps/platform/src/lib/data-analysis.ts` (kept in sync; platform must not import `@assingment/agent` server code).

### 3.7 API surface

- No new chat routes needed — tools stream through the existing `POST /api/chat` tool-result path.
- `GET /api/documents` library/preview responses already carry `filename`/`mimeType`; surface `tabularData`-derived metadata (sheet count / row count) for library cards — optional v1 polish, default to no schema change beyond the column.

## 4. v1 — Frontend (`apps/platform`)

### 4.1 New reusable components (`src/components/data/`)

- **`DataTable.tsx`** — scrollable table: sticky header, per-column type badge, row cap notice ("showing 500 of 1 204 rows"), empty state. Fully controlled (columns/rows props), unit-testable.
- **`DataChart.tsx`** — **pure SVG** (no chart library): `bar`, `line`, `scatter`, `histogram`. Responsive (`viewBox` + `preserveAspectRatio`), theme-aware via Tailwind tokens, `role="img"` + `aria-label` (axis labels + series), deterministic rendering for snapshots. Handles single-series and multi-series (legend).

### 4.2 Tool result rendering (reuse + extend)

- `apps/platform/src/components/tool-io-format.ts` (:784-846): add formatters for `read_dataset`, `analyze_dataset`, `query_dataset_sql`, `extract_document_tables`. Each returns a `FormattedSection` and, when a `chart`/table payload is present, carries it on the section for the panel to render.
- `apps/platform/src/components/tool-activity-panel.tsx`: render `<DataChart>`/`<DataTable>` inside the Result section when present — same pattern as `ToolResultImages` (:135-166).
- Because tool-result cards already sit **between the user message and the assistant text**, charts/tables flow naturally in the middle of the chat — no pinned artifacts.

### 4.3 Feature toggle

- `apps/platform/src/components/composer/features-popover.tsx`: add a **"Data analysis"** toggle following the exact Web search / Image generator pattern (switch row, `aria-checked`, availability flag).
- Per-session state in `apps/platform/src/routes/index.tsx` (mirror `webSearchEnabled`, :1074-1102, :1396-1398): `dataAnalysisEnabled` sent in `POST /api/chat` body.
- Server (`build-run-input.ts`): `dataAnalysisEnabled` gates nothing for analysis tools (they're deterministic + cheap; always available when the session has tabular sources) — the toggle is **presentational / informational** in v1. (If we later add a Python sandbox, this toggle becomes the real gate.)

### 4.4 Upload

- `apps/platform/src/components/composer/composer-attach-control.tsx` (:17): `accept` adds `.csv,.xlsx`; `apps/platform/src/lib/documents/upload-file.ts` (:2-8) adds the two MIME mappings. Upload UX is otherwise unchanged (ingest pill shows CSV/XLSX names).

## 5. Fase 2 — Deep research

### 5.1 Trigger & approval (implicit, reuses existing infra)

- **Toggle**: new "Deep research" switch in `features-popover.tsx`, per-session state, sent in `POST /api/chat` body (`deepResearchEnabled`). Mirrors Web search / Image generator exactly.
- **Tool**: `deep_research` registered on the main agent with an **approval policy** (like `web_search`): when the toggle is **on** → runs directly; when **off** → run suspends and the existing glass approval card asks (Allow once / Allow for session / Reject), including an estimated cost/latency hint. This is precisely "the agent decides it needs deep research and asks first" — no new UX, just a tool approval.
- Availability: gated on `TAVILY_API_KEY` (web) and/or linked documents (corpus); the toggle is disabled when neither is configured.

### 5.2 The researcher sub-agent

`packages/agent/src/tools/deep-research.ts`:

```
main agent
└─ tool: deep_research (approval-gated)
   └─ researcher sub-agent via agent.asTool({
        name: "deep_research", description, maxTurns: N, stream: true
      })
      ├─ own model (env-overridable, default same chat model)
      ├─ own tools: search_document_pages, web_search/web_fetch,
      │             read_dataset, analyze_dataset, query_dataset_sql,
      │             extract_document_tables   (reuse — same instances/logic)
      └─ returns a cited markdown report (string)
```

Key points:
- `asTool` exists in Anvia v0.26 (`agent-x3YTyv5i.d.ts:201`): input `{ prompt }`, output `string`, `maxTurns` bounds the loop (cost control). The researcher runs **one level of nesting**; no agent-inside-agent-inside-agent.
- The **user's intent is never isolated**: the main agent passes the user's question + a compact recap of relevant prior turns (when needed) as `prompt`. Only *retrieved evidence* lives in the researcher's working context and is discarded after the run; the final report returns to the main agent and is what gets persisted to session memory.
- Workflow lives in the researcher's **instructions** (not per-step agents): plan (a structured first model call → query list / outline) → search (tool calls over docs + web, multi-pass) → analyze (parallel narrow `createCompletion` helpers per batch, `vision-helper` pattern) → synthesize (final model call → report) → verify (re-search if gaps). Consistent with OpenAI Deep Research (single agent) and the dzhng deep-research loop (code-driven, 0 sub-agents); we only add a sub-agent where isolation/parallelism pays.
- **Caps** (env-configurable): `DEEP_RESEARCH_MAX_TURNS`, `DEEP_RESEARCH_MAX_SEARCHES`, row/result caps reused from SQL tool.
- **Progress**: the tool runs synchronously from the UI's view; emit lightweight progress via the worker-append pattern (like `compaction` in `run-worker.ts`), surfaced by `handleChatEvent` in `routes/index.tsx` — not via a new UI stream type (v0.26 UI stream ignores unknown events). `stream: true` on `asTool` also lets child events flow for Langfuse tracing.
- **Citations**: reuse `finalize-assistant-citations` + `citation-chip` so the report's claims are cited (docs + web sources).
- Not part of v1; depends on the v1 table/chart components + the tabular tools above.

## 6. Data flow (v1)

```
Upload CSV/XLSX → service (allowlist+quota) → R2 → queue ingest
  → worker tabular branch → parse → DocumentPage(0, markdown) + Document.tabularData
  → chunk+embed (findable) → status ready
Agent (chat) → read_dataset / analyze_dataset / query_dataset_sql / extract_document_tables
  → resolveDataset(prisma/r2) → TabularSheet → pure ops or sql.js (SQLite WASM)
  → tool result { result, chart? } → tool_update → part.output (JsonValue)
UI: tool-result card → DataTable / DataChart → rendered mid-chat, flows naturally
```

## 7. Edge cases

- Empty file / no header / header-only → `failed` with clear message.
- Too many rows/columns → `failed` (`MAX_TABULAR_ROWS/COLUMNS`).
- Mixed-type column → coerced to the dominant type; non-coercible cells become `null` and are counted.
- xlsx with many sheets → each sheet is a `TabularSheet`; `sheet` selector by name or index; row cap applies per sheet.
- PDF markdown table that is malformed → skipped (extract_tables returns only well-formed tables).
- SQL query safety: reject non-SELECT / multiple statements / `;`; enforce row cap; dataset registered read-only in-memory per call (never persisted, never writable).
- `analyze_dataset` on a column with all `null` → operation returns an explicit "no usable data" result, not a crash.
- Session with no tabular sources → catalog simply lists documents; agent abstains from analysis tools (behavior-eval covered).

## 8. Testing

### Unit (`packages/agent` + `apps/api`)
- `parse-csv.test.ts`: quoted fields, embedded commas/newlines, CRLF, BOM, type inference, header detection.
- `parse-xlsx.test.ts`: multi-sheet, mixed types (small fixture), row/column caps.
- `markdown-tables.test.ts`: extraction from page markdown, malformed-table skip, indexing.
- `tabular-analysis.test.ts`: profile/aggregate/filter/sort/top_n/correlation/trend + chart-spec builders (golden JSON).
- `sql.test.ts`: SELECT works, DDL/DML/multi-statement rejected, row cap + truncation flag, timeout, empty-result shape.
- API: `service.ts` allowlist (CSV/xlsx accepted, others rejected), `worker.ts` tabular branch (parse success → `ready` + `tabularData`; parse error → `failed`).

### Behavior evals (`packages/agent/evals`, existing harness)
- Tool choice: user asks to analyze an uploaded CSV → picks `analyze_dataset` (not SQL) for "average revenue by region".
- Tool choice: complex ad-hoc question over the dataset → picks `query_dataset_sql`.
- `extract_document_tables` → then `analyze_dataset` on an extracted PDF table.
- Abstain when no tabular source exists.
- (Fase 2) `deep_research` approval expectation: calls it when toggle off → approval requested; runs when on; no fabricated citations on rejection.

### E2E — real LLM, no stub (`apps/platform/e2e`, `playwright.real-llm.config.ts`)

**No LLM stub anywhere.** Extend the existing headed real-LLM config (`playwright.real-llm.config.ts`: `headless: false`, `slowMo: 150`, OpenRouter, no stub; `real-llm.global-setup.ts` asserts `OPENAI_BASE_URL` is **not** the local stub). New spec files run under the same config:

- `data-analysis.real-llm.e2e.ts` (Plan 1)
- `deep-research.real-llm.e2e.ts` (Plan 2)

**Models: real only** — `openai/gpt-5.6-luna` (default/strong; used for SQL + deep research cases) and `deepseek/deepseek-v4-flash` (cheaper/fast; basic analysis + CSV cases), selected via the UI model switcher. Cost is accepted (explicitly in scope).

Fixtures (checked in, `apps/platform/e2e/fixtures/`): `sales.csv`, `multi-sheet.xlsx`, `table-rich.pdf` (small, reproducible).

Every case below is a dedicated test (workers: 1, headed, long timeouts):

**Plan 1 — cases (each one test):**
1. **CSV upload → preview**: upload `sales.csv` → wait ready → ask "what columns does my data have?" → `read_dataset` → `DataTable` preview renders inside the tool-result card.
2. **Aggregate + bar chart**: "average revenue by region" → `analyze_dataset` aggregate → `DataTable` **and** bar `DataChart` render.
3. **Correlation + scatter**: "correlate price with sales" → scatter chart rendered.
4. **SQL**: "top 3 products by total revenue" → `query_dataset_sql` → result `DataTable`.
5. **XLSX multi-sheet**: upload `multi-sheet.xlsx` → read + analyze a non-first sheet.
6. **PDF table extraction**: upload `table-rich.pdf` → `extract_document_tables` → `analyze_dataset` on an extracted table → chart.
7. **No tabular source**: plain chat analysis request → agent answers without analysis tools (no crash, no fabricated dataset).
8. **Placement (mid-chat flow)**: assert the chart/table node sits **between** the user message and the assistant text (not pinned top/bottom).

**Plan 2 — cases (each one test):**
9. **Toggle ON → direct run**: ask a question needing cross-source synthesis (docs + web) with Deep research ON → `deep_research` runs directly (no approval card) → cited markdown report with citations visible.
10. **Toggle OFF → auto-decide → Allow once**: same question with Deep research OFF → agent decides it needs deep research → **approval card appears** → Allow once → run completes with report.
11. **Toggle OFF → Reject**: approve path rejected → agent answers without deep research, **no fabricated citations**.
12. **Corpus-grounded research**: deep research over the user's uploaded CSV + PDF + web → report cites the user's documents **and** web sources.
13. **Progress**: while deep research runs, the tool card shows a running state (progress event) in the real browser.

### Hands-on verification via MCP Playwright (real browser, must actually open)

Every case 1–13 above is also verified **hands-on with MCP Playwright against a real headed Chromium** — the browser is genuinely opened (not headless, not a stubbed driver):

- Stack on real LLM (`pnpm dev` on `:3000`/`:3001` with real `OPENAI_*`); browser opened at `http://localhost:3000`; real sign-in; fixture files (CSV/XLSX/PDF) uploaded through the **real file chooser**.
- Drive the composer as a real user; assert rendered DOM via accessibility snapshot (DataTable/DataChart, approval card, citations, running state) and capture **screenshot + console log + page snapshot per case** as evidence (repo already does this under `.playwright-mcp/`).
- **Definition of done:** each Plan 1 & Plan 2 case passes **both** (a) its automated real-LLM Playwright test **and** (b) the hands-on MCP Playwright check with the browser actually open and screenshots captured.

## 9. Out of scope

- Python sandbox / code interpreter (deferred; revisit only with a concrete product need).
- Full BI/pivot UI (drag-and-drop pivot, saved dashboards).
- Editing datasets / writing back to source files.
- Cross-session or cross-project dataset aggregation.
- Real-time data connectors (DB/API ingestion).

## 10. File map

| Area | Files |
| --- | --- |
| Schema | `apps/api/prisma/schema.prisma` (+ migration) |
| Upload | `apps/api/src/modules/documents/service.ts`, `apps/platform/src/components/composer/composer-attach-control.tsx`, `apps/platform/src/lib/documents/upload-file.ts` |
| Ingest | `apps/api/src/worker.ts` |
| Agent tools | `packages/agent/src/tools/tabular/*` (new), `packages/agent/src/tools/tabular-analysis.ts` (new), `packages/agent/src/tools/deep-research.ts` (fase 2), `packages/agent/src/index.ts` (exports) |
| Wiring | `apps/api/src/modules/chat/build-run-input.ts`, `apps/api/src/modules/chat/router.ts` (body flags), `apps/api/src/modules/chat/run-worker.ts` (progress append, fase 2) |
| Platform | `src/components/data/data-table.tsx`, `data-chart.tsx` (new), `tool-io-format.ts`, `tool-activity-panel.tsx`, `composer/features-popover.tsx`, `routes/index.tsx` (toggles), `src/lib/data-analysis.ts` (DTO + validator) |
| Tests | unit (`*.test.ts`), `packages/agent/evals/*`, `apps/platform/e2e/data-analysis.real-llm.e2e.ts` + `deep-research.real-llm.e2e.ts` (new, real LLM), `apps/platform/e2e/fixtures/` (sales.csv, multi-sheet.xlsx, table-rich.pdf) |
| Hands-on | MCP Playwright headed Chromium at `http://localhost:3000`, screenshots/console/page evidence under `.playwright-mcp/` |

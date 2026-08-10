# Agent Behavior Evals + Anvia Core Upgrade — Design

Date: 2026-08-10
Branch: `feat/agent-behavior-evals`

## 1. Goal

1. Menjaga kualitas agent tetap konsisten melalui **behavior evaluation**: tool choice, approval gates, clarification, groundedness, citations, `view_image`, dan document tools.
2. Membangun fondasi evaluasi yang **deterministik, murah, dan repeatable** sehingga development agent selanjutnya selalu berpatokan pada evaluasi.
3. Setelah kualitas terjaga, data evaluasi (usage per case) menjadi dasar optimasi **cost agent**.
4. Mengirimkan hasil evaluasi ke **Langfuse** (score per metric, terhubung ke trace run yang sama) sesuai SDK resmi Anvia.

## 2. Background & Research

- `@anvia/core@0.16.0` (terinstall saat ini) sudah punya `@anvia/core/evals`: `runEvalSuite`, `agentEvalTarget`, `exactMatch`, `contains`, `semanticSimilarity`, `llmJudge`, `llmScore`, `defineMetric`, `EvalReporter`.
- Docs resmi (`apps/www/src/content/docs/advanced/evaluations.md` & `eval-metrics.md`) eksplisit mendukung use case behavior: *"tool choice for known prompts"*, *"refusal or escalation behavior"*, dan *"Use them together with deterministic checks for tool calls, permissions, handoffs"*. Custom `EvalTarget` didesain untuk *"product behavior lives in a runner... scoped tools, retrieval, memory, trace metadata"*.
- `@anvia/langfuse@0.3.9` (terinstall) sudah punya `createLangfuseEvalReporter`, `createLangfuseDatasetClient`, `runEvalAsExperiment`.
- **Gap versi:** `runEvalCli`, `defineEvalSuite`, `gEval`, `faithfulness`, `turnRelevancy`, `knowledgeRetention`, dan metric deterministik baru (`notContains`, `containsAll`, `jsonCorrectness`, dst.) hanya ada di `@anvia/core` terbaru (0.25.x). Versi 0.16.0 TIDAK punya `runEvalCli` dan metric tersebut.
- Keputusan user: **upgrade ke 0.25.x** untuk mendapat `runEvalCli` resmi + metric lengkap.
- Tools yang ada sudah DI-friendly (`buildChatRunInput` di `apps/api/src/modules/chat/build-run-input.ts`): toggle web search / image generation, approval handler, clarification requester semuanya injectable. `documents.ts` mendefinisikan interface tipis (`FindDocumentsPrisma`, `NextPagePrisma`, `SessionDocumentIdsPrisma`, `PageImagesPrisma`, `ChunkSearchService`) yang bisa di-stub tanpa DB. Stub server + mock pattern sudah ada di `packages/agent/src/e2e/image-e2e-helpers.ts`.

## 3. Keputusan (user-confirmed)

| Topik | Keputusan |
|---|---|
| Versi core | Upgrade `@anvia/core` → 0.25.x; `@anvia/langfuse` → 0.6.x; provider adapter ikut update. Verifikasi patch `patches/@anvia__core@0.16.0.patch` (OpenAI reasoning tool-call fix) — hapus jika sudah di upstream, patch ulang jika belum |
| Branch | Satu branch gabungan `feat/agent-behavior-evals` (upgrade + eval), commit terpisah antara upgrade dan eval |
| Scope behavior iterasi 1 | Approval gate image-gen, approval gate web search, konsistensi clarification, inisiatif tool choice (dokumen vs web), groundedness & citations, `view_image`, document tools |
| Approach harness | **A: Behavior-trace target kustom + deterministic metrics** (LLM judge hanya untuk groundedness) |
| Jumlah suite | 6 suites inti (~18–22 cases) |
| Model eval | Default `deepseek/deepseek-v4-flash-0731` @ effort `max`; case `view_image` dijalankan juga di `openai/gpt-5.6-luna` (vision) dengan expectasi per model |
| Judge model | `openai/gpt-5.6-luna` @ effort extra-high |
| Tools saat eval | Semua tool nyata (factory asli) dengan dependensi di-stub (Tavily, image provider, prisma, chunk search, clarification responder, fetchPageImage) — zero side effect & zero network |
| Langfuse | `createLangfuseEvalReporter` → score ke trace; aktif hanya jika env `LANGFUSE_*` ada |
| Trigger | CLI script lokal (`pnpm --filter agent evals`), exit code untuk CI nanti |
| CI gate / scheduled suite | Belum (iterasi berikutnya) |
| Testing perubahan ini | typecheck + unit tests + e2e agent tests + smoke manual; harness di-unit-test dengan stub model deterministik |

## 4. Fase 1 — Upgrade `@anvia/core` → 0.25.x

Langkah:
1. Update `packages/agent/package.json`: `@anvia/core` → `^0.25.1`, `@anvia/langfuse` → `^0.6.1`, `@anvia/openai`, `@anvia/mistral`, `@anvia/qdrant` ke versi terbaru.
2. Hapus/update `patches/@anvia__core@0.16.0.patch` sesuai kebutuhan 0.25.x. Verifikasi apakah fix OpenAI reasoning tool-call sudah ada di upstream (cek changelog/release notes @anvia/core).
3. Perbaiki breaking changes API surface 0.16 → 0.25 di `packages/agent`, `apps/api`, `apps/platform` bila ada.
4. Verifikasi tersedia di 0.25.x: `runEvalSuite`, `runEvalCli`, `defineEvalSuite`, `agentEvalTarget`, `llmJudge`, `llmScore`, `gEval`, `faithfulness`, `createLangfuseEvalReporter`.
5. Retest: `pnpm --filter agent test`, `pnpm --filter api test`, typecheck semua workspace, e2e agent tests (`image-generation.e2e.test.ts`, `image-generation-flow.e2e.test.ts`), smoke manual approval flow.

Catatan tambahan: `ReasoningEffort` enum di `packages/agent/src/providers/openai.ts:11` saat ini `["low","medium","high"]` — perlu diperluas untuk mendukung effort `max` (DeepSeek) dan `extra-high`/`xhigh` (Luna) sesuai keys di DB seed (`deepseek: ["low","high","max"]`, `luna: ["low","medium","high"]` — verifikasi di DB saat implementasi dan sesuaikan enum + validasi).

## 5. Fase 2 — Eval Harness

### 5.1 Lokasi & struktur

```
packages/agent/src/evals/
├── harness/
│   ├── behavior-target.ts      # EvalTarget kustom: jalankan agent, kumpulkan BehaviorTrace
│   ├── run-agent.ts            # eksekusi agent (session → prompt → stream), collect events
│   ├── stub-scopes.ts          # stub Tavily, stub image model, fake prisma, stub chunk search
│   └── fixtures.ts             # corpus dokumen fixture (kecil, self-contained)
├── suites/
│   ├── approval-image.suite.ts
│   ├── approval-web-search.suite.ts
│   ├── clarification.suite.ts
│   ├── tool-choice.suite.ts
│   ├── groundedness.suite.ts
│   └── document-tools.suite.ts
├── config.ts                   # EVAL_* env + defaults
└── run.ts                      # CLI entrypoint (runEvalCli)
```

### 5.2 `BehaviorTrace` (output target per case)

```ts
type BehaviorTrace = {
  output: string;                    // teks final assistant
  toolCalls: Array<{
    name: string;
    args: Record<string, unknown>;
    status: "called" | "approval_requested" | "approved" | "rejected" | "error";
    error?: string;
  }>;
  approvals: Array<{ toolName: string; reason: string; decision: "approved" | "rejected" | "none" }>;
  clarifications: Array<{ title?: string; questions: Array<{ id; question; type }> }>;
  citations: Array<{ source: string }>;
  usage: { inputTokens?: number; outputTokens?: number };
  durationMs: number;
};
```

### 5.3 Eksekusi tanpa DB

`agent.session("eval-session").prompt(case.input).stream()` langsung di proses eval; iterate events:
- tool call events → `toolCalls` status `called`
- approval events (`tool_approval_request`) → record + decision dari policy stub (`approvalMode: "auto-approve" | "auto-reject"` per case)
- assistant text → `output`
- usage dari metadata stream

### 5.4 Stub scopes (tools asli, dependensi di-stub)

- `createWebSearchTools({ tavilyClient: stubTavily, enabled })` — fixture hasil, no network
- `createImageGenerationTools({ model: stubImageModel, store: fakeSaveStore, enabled, ... })` — implementasi `ImageGenerationModel` langsung (reuse pola `image-e2e-helpers.ts`)
- `createDocumentTools({ prisma: fakePrisma, searchService: stubChunkSearch })` — fake prisma implement interface tipis dari `documents.ts` + fixture chunks
- `createClarificationTool({ requester: autoResponder })` — auto-answer fixture, dijamin resolve
- `view_image` helper — stub vision model
- `fetchPageImage` stub → `TRANSPARENT_1X1_PNG_BASE64`

### 5.5 Case input shape

```ts
type EvalCaseInput = {
  prompt: string;
  sessionConfig: {
    webSearchEnabled: boolean;
    imageGenEnabled: boolean;
    hasDocuments: boolean;
    visionModelAvailable?: boolean;
    approvalMode?: "auto-approve" | "auto-reject";
    models?: string[];        // override per case (default EVAL_MODEL)
  };
  expected: BehaviorExpectation;
};
```

## 6. Suites & Cases

1. **`approval-image.suite.ts`** — toggle OFF → agent memutuskan generate (bukan mengarang), approval muncul; toggle ON → langsung tanpa approval; reject → graceful.
   - `image-toggle-off-requests-approval` (positif)
   - `image-toggle-off-no-hallucination` (output tidak mengklaim berhasil tanpa tool)
   - `image-toggle-on-runs-directly` (kontrol)
   - `image-approval-rejected-graceful` (negatif)
2. **`approval-web-search.suite.ts`** — pola sama untuk `web_search`/`web_fetch`.
3. **`clarification.suite.ts`** — ambigu → minta clarification; jelas → TIDAK clarification; jawaban clarification dihormati.
   - `ambiguous-prompt-asks` (positif)
   - `clear-prompt-no-clarification` (negatif)
   - `clarification-answers-respected`
4. **`tool-choice.suite.ts`** — inisiatif tool choice dokumen vs web.
   - `out-of-scope-uses-web` (positif: info tidak ada di corpus → web_search)
   - `info-in-docs-no-web` (kontrol: info ada di corpus → search_document_pages, TIDAK web_search)
   - `no-docs-knowledge-question` (mode terbuka: tanpa dokumen)
   - `library-docs-uses-context7` (opsional)
5. **`groundedness.suite.ts`** — grounded di dokumen + citation.
   - `answers-from-docs` (positif: facts dari chunk + citation ada; metric `faithfulness` vs retrievalContext)
   - `no-fabrication-when-absent` (negatif: mengakui tidak tahu, menolak mengarang)
6. **`document-tools.suite.ts`** — penggunaan tool dokumen benar.
   - `finds-then-searches` (positif: find_documents → search_document_pages)
   - `next-page-continuation` (positif: get_document_next_page bila perlu)

Case `view_image`: dijalankan di kedua model — Luna (vision) TIDAK boleh memanggil `view_image`; DeepSeek (text-only) BOLEH/WAJIB pakai helper.

## 7. Metric Strategy

| Perilaku | Metric |
|---|---|
| Approval gate, tool choice, clarifications, document tools | Custom deterministic (`defineMetric`/`defineEvalSuite` baca `BehaviorTrace`) |
| Groundedness/citations | `faithfulness` (judge) + deterministic citation-presence check; alternatif `gEval` dengan `evaluationParams: ["actualOutput", "context"]` |

Prinsip docs: *start deterministic, add judge only when needed*. 80% suite deterministic (murah, stabil). `gEval`/`llmScore` hanya untuk groundedness.

## 8. Config & CLI

Env (dengan default):
- `EVAL_MODEL` = `deepseek/deepseek-v4-flash-0731` @ effort `max`
- `EVAL_JUDGE_MODEL` = `openai/gpt-5.6-luna` @ effort extra-high
- `EVAL_CONCURRENCY` = 2
- `EVAL_TIMEOUT_MS` = 120_000
- `EVAL_REPEAT` = 1 (untuk variance nanti)
- `LANGFUSE_*` (reuse tracing yang ada; reporter aktif hanya jika tersedia)

CLI:
```
pnpm --filter agent evals                          # semua suites, pretty
pnpm --filter agent evals --suite approval-image   # filter suite
pnpm --filter agent evals --json                   # JSON output
```
`runEvalCli` dengan `exitCode: true` — exit non-zero saat fail/invalid. Filter suite via `--suite`.

Langfuse reporter: `createLangfuseEvalReporter(tracing, { onMissingTrace: "warn" })`; agent dijalankan dengan `.withTrace({ sessionId: "eval", ... })`; `case.metadata` membawa `{ suite, expectation, promptVersion }`.

## 9. Error Handling & Edge Cases

- Model/provider failure per case → `targetError` → outcome `invalid` (dipisah dari `fail`)
- Timeout per case → `Promise.race` → invalid + komentar "timeout" (indikasi agent loop)
- Rate limit → `concurrency: 2` + transient retry
- Missing env (OPENAI key) → exit early pesan jelas, exit code non-zero
- Side-effect safety: tidak ada HTTP keluar, tidak ada akses Prisma/Redis/R2/Qdrant
- Agent berhenti tanpa tool call → `toolCalls: []` → metric fail (benar)
- `view_image` dipanggil model vision → fail
- Citation hilang walau pakai dokumen → groundedness fail
- Stub tools 100% deterministik; `EVAL_REPEAT` disiapkan untuk variance

## 10. Testing & Verification

**Fase 1 (upgrade):** typecheck semua workspace (`api`, `platform`, `agent`), `pnpm --filter agent test`, `pnpm --filter api test`, e2e agent tests, smoke manual approval/streaming.

**Fase 2 (harness):**
- Unit test: `BehaviorTrace` collector & stub scopes dengan stub model deterministik (tanpa network)
- Jalankan suite beneran dengan model nyata, verifikasi metric pass/fail sesuai expectasi
- `pnpm --filter agent typecheck`, `pnpm --filter agent test`
- Dokumentasi di README evals (cara pakai, env, interpretasi hasil)

## 11. Out of Scope (iterasi berikutnya)

- CI gate di PR (suite smoke kecil)
- Suite penuh scheduled/nightly
- Langfuse dataset + experiment (`createLangfuseDatasetClient`, `runEvalAsExperiment`)
- `turnRelevancy` / `knowledgeRetention` (conversation evals)
- Cost optimization pipeline berdasarkan usage eval
- `EVAL_REPEAT` variance measurement

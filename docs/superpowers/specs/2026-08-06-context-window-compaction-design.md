# Context Window Tracking & Compaction — Design

Date: 2026-08-06
Branch: `feat/context-window-compaction`

## 1. Goal

1. Move the hardcoded model list (and reasoning efforts) into DB master tables with full metadata (context window, max input/output, pricing, icon, provider), seeded with the GPT-5.6 family defaults.
2. Show a circular context-usage indicator next to the model/reasoning switcher; hover popover lists per-model current/max tokens and pricing.
3. Compact agent memory when the estimated context exceeds a threshold, running in the **background worker** so work survives client disconnects, with visible state in the frontend and stream rejoin support.

## 2. Research summary

- **GPT-5.6 specs (developers.openai.com)**: Luna/Terra/Sol all have 1,050,000 context window, 922,000 max input, 128,000 max output, reasoning token support. Pricing per 1M (input / cached / output): Luna $0.20/$0.02/$1.20, Terra $2/$0.2/$12, Sol $5/$0.5/$30. Prompts >272K input tokens billed 2x input / 1.5x output; cache writes billed 1.25x input rate.
- **Anvia v0.16.0**: `MemoryStore` (load/append/clear/recordError) has no native compaction — app-layer. `@anvia/server` provides `ResumableStreamStore` interface + `createResumableStream`/`resumeStreamEvents`; only an in-memory store is provided, so a Redis-backed store must be implemented. `@anvia/react` `useChat` supports `resume: { key, storage, auto }`, resume cursors `{ streamId, after }` passed through `createRequest`, auto-resume on mount, `isResuming`, and persisted `ChatResumeState` (streamId, lastEventId, messages snapshot).
- **Agent stream contract**: yields Anvia UI events (message_start/text_delta/reasoning_delta/tool_update/message_end/guardrail_decision) plus `final` and `error`. Unknown event types (e.g. custom `compaction` events) are ignored for UI but delivered to `useChat` `onEvent`. `message_end` carries `usage` (inputTokens/outputTokens/totalTokens/cachedInputTokens/cacheCreationInputTokens).
- **Compaction best practices** (Microsoft Agent Framework, Anthropic, context-engineering articles): trigger before exhaustion (~70% of window), compact to a lower target (user chose 30%), chars/4 token heuristic (Microsoft `CharacterEstimatorTokenizer`), atomic tool-call groups (assistant tool-call + results removed together), summarization with a cheap model, truncation only as a backstop, compaction status must be visible to users.
- **Existing stack**: BullMQ + Redis workers already exist (document-ingest, profile-summary) with jobId dedup and Redis flag patterns; profile-summarizer shows the LLM-summarization pattern (ExtractorBuilder + cheap model + instructions).

## 3. Decisions (user-confirmed)

| Topic | Decision |
|---|---|
| Token counting | Hybrid: server estimate (chars/4 + per-message overhead + tools/instructions) synced with actual `message_end` usage after each run |
| Compaction trigger/target | Trigger 70% of active model's context window; target 30%. Env-overridable (`COMPACTION_TRIGGER_RATIO`, `COMPACTION_TARGET_RATIO`) |
| Compaction strategy | Summarize oldest messages into 1 summary (Luna, bounded ≤8% window), keep 8 recent turns intact; truncate oldest kept turns (atomic groups) only if still above target |
| Compaction failure | NO truncate-only fallback. If summarization fails, compaction is aborted entirely; run proceeds uncompacted; error is logged and surfaced |
| Model icon | Raw SVG string stored in DB (`iconSvg`), sanitized before render; seed uses the current Cpu icon |
| Model list failure | Strict: without models list, composer + send are disabled; dropdown has loading/error/empty states with retry |
| Reasoning efforts | Master table + `model_reasoning_efforts` junction (per-model gating); model without efforts shows "None" (state `null`); on model switch, effort falls back to nearest level below, else above, else null |
| Reasoning icon | Dynamic N-based gauge: fill = (index+1)/N where N = model's effort count; `null` = empty outline circle |
| Provider | Separate `model_providers` master table, FK from model |
| Pricing display | Shown in the context popover (input/cached/output per 1M + cache-write multiplier note) |
| Stream delivery | Option A: Anvia resumable streams + Redis-backed `ResumableStreamStore` |
| Agent execution | Runs in BullMQ worker (`chat-run` queue); API only validates, enqueues, and serves replay/live streams |
| Auto-retry | None (`attempts: 1`). Failures are visible; user resends manually |
| Error persistence | Failed run persisted to memory: [user message, assistant error message with `metadata.kind = "error"`]; survives refresh (DB); removed on any next send (client truncates the pair first); failed user text is prefilled in the composer |
| Global vs project chat | One code path — everything keyed by sessionId+userId (existing memory-scope); models API is global |

## 4. Data model (Prisma)

New models (follow existing `@@map` snake_case convention):

- `ModelProvider`: id, `slug` @unique ("openai"), name ("OpenAI"), sortOrder, isActive, timestamps; relation `models`.
- `ChatModel`: id, `modelId` @unique ("gpt-5.6-luna"), providerId FK, label ("Luna"), hint?, description?, `iconSvg` (default ""), `contextWindowTokens` (1_050_000), `maxInputTokens`? (922_000), `maxOutputTokens`? (128_000), `inputPricePerMTokens` Decimal(10,4)?, `cachedInputPricePerMTokens` Decimal(10,4)?, `outputPricePerMTokens` Decimal(10,4)?, `cacheWriteMultiplier` Decimal(5,3)? (1.25), `longPromptThresholdTokens` Int? (272_000), `longPromptInputMultiplier` Decimal(5,3)? (2.0), `longPromptOutputMultiplier` Decimal(5,3)? (1.5), `supportsReasoning` Boolean default true, `isActive` Boolean default true, `sortOrder` Int default 0, timestamps; `@@index([providerId])`; relation `reasoningEfforts`.
- `ReasoningEffort`: id, `key` @unique ("low"|"medium"|"high"), label, description?, sortOrder, isActive, timestamps.
- `ModelReasoningEffort`: id, modelId FK, effortId FK, `@@unique([modelId, effortId])`.

Seed (`apps/api/prisma/seed.ts` + `db:seed` script): provider `openai`; three models with the specs above and Cpu-style SVG icons; efforts low/medium/high; junction 3×3.

## 5. API surface

- `GET /api/models` → `{ models: [{ modelId, label, hint, description, iconSvg, provider: {slug, name}, contextWindowTokens, maxInputTokens, maxOutputTokens, prices: { input, cachedInput, output, cacheWriteMultiplier, longPromptThresholdTokens, longPromptInputMultiplier, longPromptOutputMultiplier }, reasoningEfforts: string[] (sorted keys), sortOrder }], reasoningEfforts: [{ key, label, description, sortOrder }] }` — active only, sorted.
- `GET /api/chat/context-usage?sessionId=` → `{ modelId, modelLabel, contextWindowTokens, maxInputTokens, maxOutputTokens, estimatedTokens, ratio, thresholdRatio, targetRatio, thresholdTokens, targetTokens, lastRunInputTokens?, reasoningEffort?, estimatedAt }`. Estimate uses the same builder as the worker (instructions/tools/context/memory) so numbers are consistent.
- `GET /api/chat/run-status?sessionId=` → `{ streamId?, status: "idle"|"running"|"completed"|"error", lastEventId? }` — for joining an active run from a device without local resume state, and for showing a banner after a failed run.
- `POST /api/chat` (rewritten):
  - No `resume`: validate model/effort against DB → single-run-per-session guard (409 when active) → generate streamId, `store.open({ streamId }, metadata {userId, sessionId, modelId, effort})` → enqueue `chat-run` job (jobId `chat:{streamId}`) → respond with envelope stream (stream_start → events → stream_end).
  - With `resume: { streamId, after }`: verify ownership from stream metadata (userId+sessionId) → `resumeStreamEvents` (replay + live tail).
  - Response is always JSONL `ResumableStreamEnvelope`s.
- `POST /api/chat/stop` `{ streamId }` → Redis flag `rs-stop:{streamId}`; worker stops appending and closes the stream as completed (partial answer stays, matching current stop UX).
- `POST /api/chat/truncate` — unchanged, reused by the client to drop the failed [user, error] pair before resending.

All endpoints use `requireUser`. No project-specific paths.

## 6. Redis resumable stream store (`apps/api/src/lib/resumable-stream-store.ts`)

Implements `ResumableStreamStore` (from `@anvia/server`) with ioredis:

- Keys: `rs:{streamId}` (hash: status, userId, sessionId, modelId, effort), `rs:{streamId}:events` (Redis Stream), `rs:{streamId}:counter` (INCR).
- `open` → SETNX status=running + metadata; reset counter; TTL 6h.
- `append` → INCR → eventId; XADD `{eventId}-0`; **throws when status ≠ running** (prevents duplicate appends on retry).
- `subscribe(after)` → XRANGE replay from `after+1`, then XREAD BLOCK loop (live tail); a `__end__` sentinel record unblocks readers on close (filtered, never yielded).
- `status` → hash status + last eventId.
- `close(status)` → set status, XADD sentinel, TTL 24h.
- `rs-stop:{streamId}` checked by the worker between events.

## 7. Worker: chat-run job

Queue `chat-run` (BullMQ, jobId `chat:{streamId}`, `attempts: 1`). Job data: `{ streamId, sessionId, userId, model, reasoningEffort, promptMessage, createdAt }`.

Processor steps:
1. Guard: store status ≠ running → skip (stopped/closed).
2. Build run input from a shared module `modules/chat/build-run-input.ts` (extracted from the current router: session docs, catalog instruction, project context/instruction, profile context/tool, document tools, agent construction). Used by both worker and context-usage endpoint.
3. Estimate tokens (chars/4 + per-message overhead + tools JSON + instructions). If > trigger (0.7 × window):
   - Append `{ type: "compaction", phase: "start", reason: "threshold"|"model-switch", model, threshold, estimated }` to the store.
   - Compaction (`modules/chat/compaction.ts`): load memory → keep 8 recent turns + system messages → summarize the prefix with Luna (`createCompletionModel("gpt-5.6-luna")` + COMPACTION_SUMMARY_INSTRUCTIONS, bounded ≤8% window) → **non-destructive: record coverage as `CompactionSegment`s in `AgentMemorySession.metadata.compaction` — a `summarized` segment (with the summary text) per pass, plus a `dropped` segment when the truncation backstop removes oldest kept atomic groups; memory rows are never deleted or rewritten** → if the summary itself exceeds 30% window, re-summarize tighter. The agent's `memory.load` view = one system summary message per `summarized` segment (in order) + rows beyond the last segment's `upToPosition`; UI history keeps ALL rows and injects a synthetic divider per segment boundary.
   - **If summarization throws: abort compaction entirely, log, append `{ type: "compaction", phase: "error" }`, continue the run uncompacted. No truncate-only fallback.**
   - Append `{ type: "compaction", phase: "complete", stats }`.
4. Run the agent stream; append every event to the store; wrap with existing taps (usage recording, citations finalize); check `rs-stop` flag between events.
5. On success: close store `completed`; set title if empty; release active-run key.
6. On failure: append `{ type: "error", error }`, write the failed pair to memory ([user prompt with its clientMessageId metadata, assistant error message with `metadata.kind="error"`]), close store `error`, release active-run key.
7. BullMQ `failed`/`stalled` handlers → same failure path (idempotent close).

Sanitized memory store used by the agent's `load` filters `metadata.kind === "error"` artifacts (UI-only; model never sees them) and builds the compacted view from `metadata.compaction` segments (summaries + uncovered rows). `loadEnrichedMemoryMessages` returns all rows unchanged and injects synthetic `kind: "summary"` divider rows at segment boundaries so the UI renders the summary dividers.

## 8. Frontend

- `useChat` (index.tsx): `resume: { key: sessionId, storage: "sessionStorage", auto: true }`; `createRequest` includes `resume`; `onEvent` → compaction events (indicator state), `message_end` (sync actual usage), `error` (composerError banner). On session open: fetch `run-status`; if a run is active and no local resume state → inject `ChatResumeState` (`anvia:chat-resume:{key}`) into sessionStorage and call `chat.resume()` (cross-device join). If status is `error` → banner "Run sebelumnya gagal — kirim ulang?".
- Failed-run handling: on error event → prefill composer input with the failed user text; on any next send → `truncate(exclude, clientMessageId)` for the failed pair first (fire-and-forget, non-blocking), then send.
- `useModels` hook (module-level cache): `{ models, reasoningEfforts, status: loading|error|success, retry }`. Strict gating: composer + send disabled until success; error → card + retry; empty → "no models available".
- Model/effort state: `model: string`, `effort: string | null`. `resolveReasoningFallback(effort, modelEfforts)` → level below → level above → null. `chat-preferences.ts` validates stored ids against the models list; `CompletionModelId` union → long string type + `isKnownModelId(models, id)`.
- `ReasoningEffortIcon({ effort, total })`: dynamic gauge, fill = (index+1)/total, null = empty outline; used in dropdown, switcher button, popover.
- `ContextUsageIndicator` (right of the switcher in `chat-composer.tsx`):
  - SVG ring: ratio = estimatedTokens / activeModel.contextWindowTokens (cap 100%); colors: normal → amber ≥70% → red ≥90%.
  - States: loading (skeleton ring), error (warning icon + tooltip, composer still usable), compacting (ring pulse + blink "Compacting context…"), idle.
  - Hover popover (portaled, reuses `select-list` patterns): table of all models — icon, label, provider, current/max tokens with mini progress bar, ratio %, prices, threshold marker. Loading/error/empty states inside the popover too.
- Summary divider: the API injects a synthetic system row (`metadata.kind === "summary"`, content = the segment's summary, `""` for dropped segments) after the row at each compaction segment boundary; history rows with `metadata.kind === "summary"` render as a subtle "Earlier conversation summarized" divider (Claude.ai style), not a system bubble. All original chat bubbles stay in the list (compaction never touches rows).
- Error bubble: assistant message with `metadata.kind === "error"` renders with danger styling (reuse `danger-soft`/`text-danger` patterns).
- Reused components/utilities: `SelectOptionList`, glass shell classes, portal positioning from the switcher, `truncateSessionMemory`/`clientMessageId` metadata, existing error/composerError rendering, `tapAgentStreamUsage`, `tapStreamComplete`, profile-tap pattern.

## 9. Error handling & edge cases

- Models API down → strict block + retry card.
- 409 duplicate run (another tab) → toast "Session sedang diproses di tab lain".
- Resume of unknown/expired stream (TTL) → error envelope; history intact from memory Postgres.
- Stop → worker closes stream `completed`; partial answer stays; resume state cleared on stream_end.
- Compaction failure → abort compaction (no truncation), run continues, indicator flashes warning (non-blocking), logged.
- Model switch to smaller window → worker compacts before answering (same path; no extra client logic).
- Worker crash mid-run → BullMQ stalled → failed handler → error event + failed pair persisted + close `error`.
- Run failure persists across refresh via memory DB; removed on any next send (client truncate) — if DB write of the failed pair itself fails (extreme), client-side prefill still covers the current session.
- Global vs project chat: single code path (sessionId+userId keyed); documents resolution already project-aware.

## 10. Verification

- `prisma migrate dev` + seed; verify seed rows.
- `tsc` typecheck in api/platform/agent; lint; build.
- Smoke: send → open tab close → reopen → answer continues streaming (resume); switch model to smaller window → compaction event + indicator; kill worker mid-run → error bubble persists after refresh; strict model-list failure state.

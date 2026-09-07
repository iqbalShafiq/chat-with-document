# Anvia v1 Browser Acceptance and QA

**Verified:** 2026-08-25 14:05 WIB  
**Branch:** `feat/anvia-v1-migration`  
**Anvia train:** exact `1.0.1`

## Acceptance decision

Task 18 browser work is functionally green on focused reruns. The latest
serial real-provider invocation was **22/24** (37.4 minutes). The two failures
were then fixed and rerun focused, with no retries:

- native queue edit/reorder/FIFO: **1/1 in 23.8s**;
- Deep Research mixed CSV/PDF/web (C12): **1/1 in 8.3m**.

C13 (progress visible, terminal stream) passed both focused (**1/1 in 3.7m**)
and in the serial suite (**1/1 in 2.9m**). Worker-restart question and approval
passed **2/2**. Protocol JSONL event-id/terminal/cursor checks passed **1/1**.

Every real LLM scenario selected `deepseek/deepseek-v4-flash-0731` and
reasoning `max`. No LLM stub participated in those results.

The deterministic suite completed **15/15 in 59.6s** with retries disabled.
It is retained only for fast UI and protocol regression. Its local OpenRouter
stub is not counted as model-quality or provider acceptance evidence.

A fresh serial 24/24 real-LLM invocation was not repeated after the two
focused fixes.

## Commands and results

Real-provider acceptance:

```bash
pnpm exec playwright test --config=playwright.real-llm.config.ts --retries=0
```

Result of the latest serial invocation: **22 passed / 2 failed (37.4 minutes)**,
headed Chromium, one worker, no retry. The suite now covers six migration
cases (protocol JSONL, stop/regenerate, question replay, queue edit/reorder,
required-choice worker restart, web-approval worker restart), eight
data-analysis cases, five Deep Research cases, and five general
real-provider/tool cases.

Focused reruns after the two serial failures: queue **1/1**, C12 **1/1**.

Deterministic browser regression:

```bash
set -a
source /Users/shafiq/VsCodeProjects/chat-with-document/.env
set +a
OPENAI_BASE_URL=http://127.0.0.1:18765/api/v1 \
OPENAI_API_KEY=e2e-key TAVILY_API_KEY=dummy \
pnpm exec playwright test --config=playwright.config.ts --workers=1 --retries=0
```

Result: **15 passed (59.6 seconds)**, Chromium, one worker, no retry. The
explicit environment load is required because ignored secret files are not
copied into an isolated Git worktree. Provider variables are then deliberately
overridden for this stub-only regression suite.

Focused stability gates run during diagnosis also passed:

- exact reload/resume: 2/2 without retry;
- native queued follow-ups: 2/2 without retry;
- Deep Research mixed-corpus case: 1/1 with the real model;
- transport and composer regressions: 27/27;
- Deep Research tool regressions: 17/17;
- API and platform TypeScript checks implicated by the fixes.

## Covered product behavior

The real suite verifies Anvia protocol v3 headers and a valid resumable snapshot
before reload, exact-once stream continuation, stop and native regenerate,
native question suspension across reload, replay and wrong-session rejection,
and two editable FIFO follow-ups acknowledged by the native queue.

It also verifies streamed reasoning/text, statistics, live Tavily search, the
live image API, CSV and XLSX analysis, PDF table extraction, SQL, aggregation,
correlation, DataTable/DataChart placement, direct and gated Deep Research,
rejection without fabricated citations, visible one-level research activity,
and a grounded CSV + PDF + authoritative-web report.

Native questions are intentionally required-only. The former v0 optional-skip
behavior was removed rather than preserved through a compatibility adapter.

## Evidence

The repository evidence convention was preserved:

- `.playwright-mcp/anvia-v1/`: screenshots, accessible snapshots, and protocol
  metadata for reload/resume, stop/regenerate, question replay denial, and the
  native queue;
- `.playwright-mcp/data-analysis/`: screenshot, console, and page evidence for
  P1-C1 through P1-C8;
- `.playwright-mcp/deep-research/`: screenshots, page snapshots, console JSON,
  and scenario summaries for P2-C9 through P2-C13.

No credentials, prompts containing secrets, hidden reasoning, or raw tool
arguments are written to these artifacts.

## Defects found and fixed

Browser-first diagnosis found several cross-boundary defects that narrower
tests did not expose:

1. A route-level error callback called `chat.stop()` during reload abort. The
   official stop path clears Anvia's resume snapshot, so reload could not
   continue. Stop ownership now remains with explicit user intent, and resume
   waits for the exact hydrated model/reasoning policy tuple.
2. Follow-up requests replayed the entire rendered transcript, including large
   assistant reasoning, and breached the API message limit. The server's Anvia
   memory is authoritative; transport now sends only the latest user prompt
   while the client retains the full transcript for rendering/resume.
3. `useChat.sendMessage()` can resolve after its `onError` callback. The queue
   previously treated that as success and removed an unsent item. A bounded
   request-failure signal now prevents acknowledgement on failed sends.
4. A nested Deep Research run could outlive the browser timeout and retain its
   active lease. Deep Research now has a frozen, configurable wall-clock budget,
   propagates an abort signal to the child researcher, disposes timers/listeners,
   and fails closed. The mixed-corpus acceptance case is also bounded to at most
   four retrieval/tool calls while still requiring CSV, PDF, authoritative web,
   citations, disagreement handling, and verification.
5. Real-stack runs also exposed strict optional-event serialization, document
   identifier, Mistral embedding-dimension, CORS, run-status race, truncation,
   and interaction-resume persistence issues. Each received a focused regression
   before the relevant real-browser scenario was rerun.
6. After Deep Research completed, the parent opened a second `web_search`
   approval loop (C13). Parent evidence tools are now sealed for the rest of
   that run; nested researcher tools stay unsealed. C13 now fails closed if a
   second web approval appears.
7. Browser exact-once coverage now parses completed JSONL frames: monotonic
   event IDs, exactly one terminal frame, `parseClientStreamFrame`, resume
   cursor `after > 0`, and a stored replay from `after: 0`.
8. Interaction durability is exercised across an actual chat-worker SIGTERM
   restart owned by the worker pid file + `tsx --watch` supervisor, for both
   a required-choice question and a web-search approval.

## Residual scope

No known browser product blocker remains after the focused reruns. A serial
24/24 real-LLM rerun is optional before the Task 18 commit. Final
removed-API/import audits, `isSessionStale()` fail-open, complete package
verification, data/rollback review, and independent whole-branch review remain
Task 19 release-readiness gates.

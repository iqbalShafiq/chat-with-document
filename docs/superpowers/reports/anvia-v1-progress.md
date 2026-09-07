# Anvia v1 Migration — Development Handoff

**Updated:** 2026-08-25 14:05 WIB  
**Branch:** `feat/anvia-v1-migration`  
**Worktree:** `/Users/shafiq/.codex/visualizations/2026/08/23/01a02f0b-3f96-7971-894c-f3e9bd5e3f20/chat-with-document-anvia-v1`  
**Latest committed checkpoint:** `6bac0c8` (`test: verify Anvia v1 service integration`)  
**Target release train:** exact Anvia `1.0.1`

This is the resume source of truth. The design spec remains
`docs/superpowers/specs/2026-08-23-anvia-v1-migration-design.md` and the full
implementation plan remains
`docs/superpowers/plans/2026-08-23-anvia-v1-migration.md`.

## Executive status

Tasks 1–17 remain committed. Task 18 is implemented and focused-verified, but
**not committed**. Task 19 has **not started**.

Do not merge. The working tree is intentionally dirty with Task 18 product
fixes, tests, redacted evidence, and reports.

| Area | Status | Current evidence |
|---|---|---|
| Anvia packages and server architecture | Complete | exact `1.0.1`, Tasks 1–17 committed |
| C13 Deep Research terminal stall | Fixed | parent retrieval sealed after `deep_research`; focused 1/1 and suite 1/1 |
| Queue edit/reorder/FIFO | Fixed and focused-green | 1/1 in 23.8s after assertion/prompt hardening |
| JSONL protocol event IDs | Added | live resume + stored replay assertions; 1/1 in 59.7s |
| Worker restart interactions | Added | required-choice + web approval, 2/2 in 1.0m |
| Latest serial real-LLM suite | 22/24 then focused reruns | queue assertion and C12 window failed in-suite; both passed on focused rerun |
| Deterministic UI/protocol suite | Pass | 15/15, 59.6s, retries 0 |
| Task 18 commit | Not created | waiting on docs + optional full 24/24 rerun |
| Task 19 release audit | Not started | `isSessionStale()` fail-open still open |

## C13 root cause (verified, not a timeout)

The retained Playwright snapshot showed Deep Research already `Done`. The
parent then opened independent `web_search` calls, which required approval.
The composer stayed on `Waiting for agent` / `Stop` for 480s.

The scalable fix is a run-scoped completion guard:

- `deep_research` marks the run as closed when execute starts;
- parent evidence tools skip approval and return a bounded error instead of
  opening a second retrieval/approval loop;
- nested researcher tools stay unsealed;
- a second `deep_research` call returns the same bounded message.

Production's six-minute nested budget was not increased.

## Task 18 work in the dirty tree

In addition to the previous uncommitted browser fixes:

1. Parent retrieval seal after Deep Research (`packages/agent` + server/eval wiring).
2. C13 e2e fails closed if a second web-search approval appears.
3. Queue e2e expands before asserting hidden items, edits/reorders while
   streaming, and checks flushed user-message order.
4. Browser JSONL assertions: monotonic event IDs, one terminal frame,
   parseable `anvia.client.v3` frames, resume cursor `after > 0`, full stored
   replay from `after: 0`.
5. Worker pid file published when the chat-run queue is ready; e2e SIGTERM +
   `tsx --watch` restart; required-choice question and web-search approval
   both survive the restart.
6. C12 browser window allows parent synthesis after the six-minute child
   budget; the child budget itself is unchanged.

## Browser results

All real runs used headed Chromium, one worker, retries disabled, OpenRouter,
`deepseek/deepseek-v4-flash-0731`, and reasoning `max`.

- Serial real suite: **22/24 in 37.4m**. Failures were queue order assertion
  (user-message `FIRST_QUEUE_OK. EDITED` was present; exact assistant token
  was not) and C12 still synthesizing at 480s.
- Focused queue rerun after assertion/prompt hardening: **1/1 in 23.8s**.
- Focused C12 rerun with 10-minute waitForRunDone: **1/1 in 8.3m**.
- Focused C13: **1/1 in 3.7m**; also passed in the serial suite (2.9m).
- Protocol JSONL reload/resume: **1/1 in 59.7s**.
- Worker-restart question + approval: **2/2 in 1.0m**.
- Deterministic stub suite: **15/15 in 59.6s**.
- Deep Research unit tests: **23/23**.

A fresh serial 24/24 real-LLM invocation was not repeated after the two
focused fixes.

## Remaining before Task 18 commit

1. Optional: one serial 24-case real-LLM rerun with no retries.
2. Independent read-only review of the Task 18 diff.
3. Update `anvia-v1-browser-qa.md` to match the honest 22/24 + focused-rerun
   record (in progress in this working tree).
4. Confirm evidence directories stay redacted (no raw prompts, cookies, or
   tool arguments). `test-results/` traces stay untracked.
5. Commit only when accepted, proposed message:
   `test(e2e): verify Anvia v1 product parity`.

## Task 19 still pending

- removed-API and browser/server import-boundary audit;
- `isSessionStale()` fail-open in `apps/platform/src/routes/index.tsx`;
- frozen install, complete tests, TypeScript, builds, Prisma, E2E;
- data/session/compaction and rollback-safety audit;
- whole-branch review and final verification report.

## Pause state

- Development servers were stopped with SIGINT; ports 3000/3001 are clear.
- Redis has **0** `rs-active:*` leases.
- Docker PostgreSQL, Redis, and Qdrant remain running but idle.
- `.env` was copied into the worktree for local runs and must not be
  committed.
- No Task 18 commit was created.

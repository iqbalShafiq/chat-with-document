# Anvia v1 Task 19 Production-Readiness Review

**Reviewed:** 2026-08-25
**Branch:** `feat/anvia-v1-migration` @ `3bdfb29` (`test(e2e): verify Anvia v1 product parity`) plus uncommitted Task 19 files
**Compared to:** `origin/main` (`6818961`) and local `main` (`f68a44e`)
**Scope:** whole-branch runtime in `packages/` and `apps/`, plus dirty-tree Task 19 edits. Docs-only v0 mentions were not treated as defects.

Uncommitted Task 19 files at review time:

- `apps/platform/src/lib/chat/session-freshness.ts` (untracked)
- `apps/platform/src/lib/chat/session-freshness.test.ts` (untracked)
- `apps/platform/src/routes/index.tsx`
- `apps/platform/e2e/anvia-v1-migration.e2e.ts`
- `packages/agent/src/tools/deep-research.ts`
- `packages/agent/src/tools/deep-research.test.ts`
- `README.md`

## Summary

The v1 cutover is architecturally complete: runtime no longer calls removed v0 APIs, the browser bundle stays on `@anvia/client` / `@anvia/react` / `@anvia/react-ui` plus the allowed `@anvia/core/agent/interactions` subpath, recipes reject secrets, streams are `anvia.client.v3`, native interactions claim/enqueue/consume without holding a worker, and Deep Research parent-seal plus ordered worker shutdown are in place. Task 19 correctly fail-closed **resubmit/revert** when session freshness is unknown, but the composer **failed-tail truncate** is still fire-and-forget and races the following send, so a retry after an error can delete the new prompt (and any later rows) from Prisma. Interaction resume also short-circuits `claimed` records before the store's stale-lease reclaim path, which can leave an approval stuck after a crash/release failure. Do not ship until the truncate-before-send race is fail-closed.

## Issues

### Issue 1 -- Severity: bug
- File: apps/platform/src/routes/index.tsx:2929
- Description: Composer submit still treats failed-tail cleanup as a non-blocking best-effort. After a persisted `[user, assistant kind:"error"]` tail, `submitComposerRef` starts `checkSessionFreshness()` in parallel, then `void truncateSessionMemory({ mode: "exclude", clientMessageId }).catch(() => {})`, locally slices the two messages, and immediately `await sendDraft(...)`. That is fail-open in three ways. (1) Truncate is not awaited, so the new `/api/chat` job can persist the retry prompt while the Serializable truncate transaction still deletes `position > keepThrough` of the failed user row — wiping the new prompt and any later rows, including another window's messages. Resubmit does the opposite correctly: it awaits freshness, fail-closes on `"unknown"`, then awaits truncate before send (`index.tsx:2673` and `2685`). (2) Truncate errors are swallowed, so a 404/500 still sends. (3) Freshness is only used afterwards as `=== "stale"` to show a notice (`index.tsx:2968`); `"unknown"` does not block this destructive delete. Server truncate (`apps/api/src/modules/chat/truncate-memory.ts:183`) has no "target must still be the tail" guard, and this call omits `expectedPrefixMessageCount`. Task 19's `blocksDestructiveSessionAction()` is unused on this path even though its comment names truncate (`session-freshness.ts:17`).
- Suggestion: Treat failed-tail cleanup like resubmit. Await `checkSessionFreshness()`; if `blocksDestructiveSessionAction(freshness)`, do not truncate or send (unknown → composer error, stale → reload dialog). Await truncate and abort send on failure. Pass `expectedPrefixMessageCount` for the prefix before the failed user message. Optionally fail closed on the server when exclude-by-clientMessageId would delete rows after a non-error tail. Add a regression that a send after an error tail cannot run until truncate commits, and that fetch/truncate failure does not POST `/api/chat`.
- Status: fixed (failed-tail helper now fail-closes freshness and awaits truncate with `expectedPrefixMessageCount` before `sendDraft`)

### Issue 2 -- Severity: suggestion
- File: apps/api/src/modules/chat/router.ts:693
- Description: Interaction resume fail-closes double-submit by returning `INTERACTION_CLAIMED` whenever `existing.state === "claimed"`, before `enqueueChatResume`. The Redis claim script already reclaims an expired lease (`interaction-store.ts:106`, `INTERACTION_CLAIM_LEASE_SECONDS` = 2 minutes) and `enqueueChatResume` is documented as the crash-reconciliation path (`run-queue.ts:264`). The router never reaches that path. After claim succeeds and the process dies before `queue.add`, or add fails and `release` also fails, a retry is 409 for the remaining interaction TTL (15 minutes) even once the claim lease has expired. Tests lock the short-circuit in (`interaction-resume.test.ts` `"short-circuits %s interaction before open/lease"`). In-flight double-click protection is right; refusing expired claims is not.
- Suggestion: Keep 409 for a live claim (`claimExpiresAt` in the future). If the lease has expired, call `enqueueChatResume` so Lua can return `reclaimed` / `stale-claim` and retry once. Do not open a second stream/lease until that claim result is `reclaimed` or a new pending claim.
- Status: open

### Issue 3 -- Severity: suggestion
- File: apps/api/src/modules/chat/router.ts:766
- Description: `resolveChatAgentRecipe` failures of every kind become HTTP 404 `CHAT_REQUEST_NOT_AUTHORIZED`. Prisma/Redis/Qdrant/model-catalog outages, validation errors, and true authorization misses are indistinguishable. Recipe construction does release a single-use context claim on its own failure (`build-run-input.ts:937`), so this is not a leak, but operators and the client cannot tell "you may not use this session" from "the chat backend is down", and clients will not retry a 404.
- Suggestion: Map known auth/not-found errors to 404. Let unexpected errors surface as 5xx (or a bounded 503) without claiming a run lease. Do not catch `unknown` and coerce it to unauthorized.
- Status: open

### Issue 4 -- Severity: suggestion
- File: apps/api/src/worker-lifecycle.ts:39
- Description: Shutdown order is correct (stop accepting → cancel active streams → close BullMQ workers → Qdrant → Context7 → tracing → Prisma → Redis) and failures aggregate instead of being swallowed (`worker-lifecycle.ts:63`, `worker.ts:463`). There is no deadline. `cancelAll` waits on every run's `done`; `chatWorker.close()` waits for in-flight jobs; `closeTracing()` is `tracing.close()` with no timeout (`packages/agent/src/tracing.ts:20`). A hung Langfuse/Qdrant/Redis close, or a run that never settles, blocks SIGTERM until the orchestrator SIGKILLs the process, skipping later closes (including Redis).
- Suggestion: Bound each `closeStage` (and the overall shutdown) with an explicit timeout, log the timed-out name, continue later stages, and still exit non-zero. Keep the current "do not swallow timeout diagnostics" rule.
- Status: open

### Issue 5 -- Severity: nit
- File: apps/platform/src/lib/chat/session-freshness.test.ts:21
- Description: Task 19 unit tests only cover the helper. They assert `blocksDestructiveSessionAction("unknown") === true` for "truncate/resubmit", but there is no route/composer test that a failed-tail send is blocked when `fetchSessionState` throws or that truncate is awaited. The helper can stay green while Issue 1 remains.
- Suggestion: After fixing Issue 1, add a focused UI test around `submitComposerRef`: failed tail + freshness `"unknown"` must not call truncate or `sendDraft`; failed tail + `"fresh"` must await truncate before send.
- Status: open

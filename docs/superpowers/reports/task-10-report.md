# Task 10: Durable native interaction continuations

Date: 2026-08-25
Worktree: `/Users/shafiq/.codex/visualizations/2026/08/23/01a02f0b-3f96-7971-894c-f3e9bd5e3f20/chat-with-document-anvia-v1`

## Delivered

- Added `apps/api/src/modules/chat/interaction-store.ts` with a Redis-backed native interaction state machine:
  - `pending -> claimed -> consumed` and atomic enqueue-failure `claimed -> pending` release.
  - Expiry and claim-lease expiry use Redis `TIME`, not caller wall-clock values.
  - Claim tokens are owner-bound, same-token retries are idempotent, and abandoned claims are atomically reclaimed.
  - Interaction keys use a SHA-256 hash-tag (`chat-interaction:{<64-hex>}`), so raw interaction ids never become Cluster hash tags.
  - Canonical SHA-256 fingerprints make identical puts idempotent and conflicting puts fail closed; bounded serialization rejects oversized payloads.
  - Redis Lua transitions check ownership, state, lease, immutable fingerprint, response fingerprint, resume stream, and deterministic job binding atomically; an expired lease can only be reclaimed with the already-bound response/stream identity.
  - Records persist a versioned `interaction-v1` schema containing request, continuation, recipe, source stream/run, ownership, fingerprint, timestamps, state, response binding, resume stream, and accepted-job marker.
  - Stored records and tombstones reject unknown fields, malformed JSON, invalid official Anvia interaction/continuation/response values, identity mismatches, invalid timestamps, invalid state, fingerprint drift, state-incompatible response bindings, and state-incompatible claim fields.
  - Stable `expired`, `replayed`, `claimed`, `conflict`, `claim_mismatch`, `stale_claim`, and `corrupt` error codes fail closed across logical expiry, replay, lease, and corruption paths.
  - `createInteractionPersistenceCallback` exposes the awaited Task 9 `onInteraction` callback; persistence failures propagate to the adapter.
- Narrowed `approval-registry.ts` to app-owned session grants and one-shot argument overrides. Legacy polling approval and clarification waiters, decision keys, list/re-emit helpers, and stop-unblock polling were removed without compatibility shims. Grant/override keys use a digest of the tuple rather than delimiter concatenation.
- Added deterministic `interactionResumeJobId` / `enqueueChatResume` in `run-queue.ts`; claim tokens are not part of `ResumeRunJob` serialization.
- `enqueueChatResume` now validates the immutable stored continuation/recipe, claims with the stored fingerprint, adds with the deterministic job id, consumes with a persisted `jobId` marker, releases only when the add fails, and leaves an accepted-but-not-consumed claim for lease recovery. Task 11 still owns route-level request/stream orchestration around this helper.
- Redis physical retention is state-specific and longer than logical TTL (`pending`, `claimed`, `consumed`, and `expired`), preserving durable expiry tombstones and accepted-job reconciliation until retention ends. Tombstones are independently schema-validated and preserve Cluster-safe hashed key slots.
- Replay/idempotency is intentionally finite: the tombstone horizon is 30 days. Within that horizon, expired/replayed interactions return stable product errors; after both primary and tombstone keys expire, `get()` returns `null`/`not_found`. No permanent ledger is maintained. Task 11 must map missing/expired/replayed results without enumeration, and only the trusted Anvia producer may persist new collision-resistant interaction ids after the horizon.
- Replaced the approval-registry tests with focused app-policy tests and added state-machine, process-recreation, replay, ownership, type-mismatch, expiry, corruption, idempotency, lease-reclaim, stream-binding, accepted-job reconciliation, and callback-failure coverage.

## Verification

Focused command:

```text
pnpm exec vitest run src/modules/chat/interaction-store.test.ts src/modules/chat/interaction-store.redis.test.ts src/modules/chat/approval-registry.test.ts src/modules/chat/run-queue.test.ts
```

Result: **4 files passed, 48 tests passed**. The Redis suite executed the production Lua scripts against `redis://127.0.0.1:16379`, covering put/claim/consume/reconciliation, concurrent claims, server-time lease reclaim with bound-stream enforcement, logical expiry, TTL retention, finite-horizon behavior, tombstone bindings, hash-slot-safe keys, and state-incompatible/unknown corrupt hashes. It required the approved elevated command because the sandbox cannot connect to the local Redis socket (`EPERM 127.0.0.1:16379`); this was an infrastructure permission limitation, not a skipped test.

Earlier full API command:

```text
pnpm exec vitest run --reporter=dot
```

Result: **38 files passed, 3 failed; 336 tests passed, 18 failed, 5 skipped; 1 unhandled error**. The failures are migration-wide baseline work outside Task 10 plus the intentionally removed legacy waiter callers: Anvia v1-incompatible steering/vision/image-generation tests, the legacy `image-generation-flow.e2e.test.ts` hook/listener failure, and stale pre-Task-11/12 router/worker integration. The focused Task 10 suites remain green.

Full typecheck diagnostic:

```text
pnpm exec tsc --noEmit --pretty false
```

Result: **fails with 103 diagnostic lines**, all in the expected pre-Task-11/12 router/worker/session-delete and legacy image/steering/vision seams. Filtering the output for `interaction-store`, `interaction-store.redis`, `run-queue`, and `approval-registry` yields **no Task 10 diagnostics**.

`git diff --check`: **passed**.

Task 11 still owns route-level parse/authentication, stream opening, and the outer claim -> queue add -> consume/rollback orchestration. Task 10 supplies the durable store and deterministic `enqueueChatResume` helper; no router or worker migration was performed.

No commit was created.

# Task 11 report — canonical Anvia v1 chat router

Date: 2026-08-24
Branch: `feat/anvia-v1-migration`
Worktree: `/Users/shafiq/.codex/visualizations/2026/08/23/01a02f0b-3f96-7971-894c-f3e9bd5e3f20/chat-with-document-anvia-v1`

## Scope completed

The complete Task 11 API cutover is implemented on top of Task 10's finalized
response-bound claim/consume API. The route accepts only the official Anvia v1
request union, authorizes product metadata before queueing, and returns native
protocol-v3 resumable streams.

Files changed for this checkpoint:

- `apps/api/src/modules/chat/client-request.ts`
- `apps/api/src/modules/chat/client-request.test.ts`
- `apps/api/src/modules/chat/client-protocol.test.ts`
- `apps/api/src/modules/chat/interaction-resume.test.ts`
- `apps/api/src/openapi/components.ts`
- `apps/api/src/openapi/paths/chat.ts`
- `apps/api/src/openapi/document.test.ts`
- `apps/api/src/openapi/document.ts`
- `.superpowers/sdd/2026-08-23-anvia-v1-migration/progress.md`

## Canonical parser behavior

`client-request.ts` calls `parseClientStreamRequest` before applying product
policy. It accepts only the official `messages` and `interaction_response`
union, with an optional top-level cursor on either branch. Product metadata is
strict and requires session id, bounded/unique document ids, model and effort,
all feature flags, and an explicit `imageGenSettings` value (`null` or a
strict object). Blank/invalid settings and contradictory image policy are
rejected. Fresh messages require a non-empty array whose final item is a user
message. Errors are bounded `ChatRequestError` values and never echo prompt,
tool input, continuation, recipe, or provider diagnostics.

## RED/GREEN evidence

The parser tests were first written against the missing module and failed with
`Cannot find module './client-request.js'`. After the implementation:

```text
pnpm --dir apps/api exec vitest run src/modules/chat/client-request.test.ts
Test Files  1 passed (1)
Tests       9 passed (9)
```

The OpenAPI tests were first made RED for the old request fields, deleted
approval/clarification operations, and missing staging operation. After the
OpenAPI changes:

```text
pnpm --dir apps/api exec vitest run src/openapi/document.test.ts
Test Files  1 passed (1)
Tests       5 passed (5)
```

The protocol integration test is now GREEN against `resumeClientStreamResponse`
and verifies the v3 header, NDJSON framing, contiguous event ids, stream end,
cursor replay, and absence of raw legacy approval/clarification events. Route
state-machine coverage verifies missing cursors do not enqueue work and legacy
approval/clarification mutation routes are absent.

```text
pnpm --dir apps/api exec vitest run \
  src/modules/chat/client-request.test.ts \
  src/modules/chat/client-protocol.test.ts \
  src/modules/chat/interaction-resume.test.ts \
  src/openapi/document.test.ts

Test Files  4 passed (4)
Tests       18 passed (18)
```

The API typecheck remains intentionally RED across pre-existing Task 10–12
boundaries. The new parser/OpenAPI files introduce no independent diagnostic.
`git diff --check` passes for the scoped edits.

## Router invariants

1. Fresh messages resolve and freeze a recipe, acquire a session lease, open
   stream metadata, then enqueue a strict `start` job. Pre-acceptance errors
   close the stream and release the lease.
2. Cursor requests only validate ownership/session/cursor horizon and subscribe;
   they never enqueue work.
3. Native interaction responses validate frozen metadata, open a new stream,
   then delegate claim/add/consume ordering to Task 10's `enqueueChatResume`.
   Accepted-but-unreconciled jobs return the stream subscription without
   releasing the claim.
4. Stop sets the stream stop flag and returns `{ ok: true }`; no legacy waiter
   cancellation is performed.
5. The staging endpoint validates the native approval response against the
   persisted request before writing any policy. It now writes only to the
   durable interaction-policy store, keyed by a hash of `interactionId`, with
   the server-owned user/session/tool identity and native response fingerprint.
   It never calls the legacy `(sessionId, toolName)` registry and therefore
   cannot activate a session grant or global override before the resumed
   worker claims the exact interaction-bound stage.

## Interaction-policy staging hardening

`apps/api/src/modules/chat/interaction-policy-store.ts` is a versioned Redis
Lua state machine:

- `stage` validates bounded identity/fingerprint/TTL values and performs an
  exact idempotent write; a changed policy, owner, or tool is a conflict.
- `claim` is a single-key atomic lease transition bound to user, session, tool,
  and native response fingerprint. It returns the complete immutable identity
  and claim binding; `release` supports rollback/reclaim and `consume` removes
  executable fields only after worker application.
- Redis hashes use a SHA-256 interaction key with a cluster hash tag and a
  strict allowlist of persisted fields. Logical expiry is retained as a
  tombstone long enough to make late retries deterministic; policy payloads
  are removed on consume/expiry.

The route uses the persisted interaction record for ownership and pending-state
validation, uses the official Anvia response parser/assertion before the first
policy write, and validates image overrides against the v1 generate/edit tool
argument bounds. OpenAPI now documents the explicit image override fields and
the policy-store-unavailable response.

## Additional RED/GREEN evidence

The new route tests were first run while the route still used the legacy
registry and failed with the deliberate `staging must not activate the legacy
approval registry` assertion. After the cutover:

```text
pnpm --dir apps/api exec vitest run \
  src/modules/chat/interaction-staging.test.ts \
  src/openapi/document.test.ts
Test Files  2 passed (2)
Tests       10 passed (10)
```

The Lua/atomic behavior is covered by a real Redis integration suite. It does
not skip when Redis is unavailable; the first sandboxed attempt failed with an
explicit local-connectivity error and the authorized run against the project's
Redis service passed:

```text
pnpm --dir apps/api exec vitest run \
  src/modules/chat/interaction-policy-store.redis.test.ts
Test Files  1 passed (1)
Tests       5 passed (5)
```

That suite covers stage/claim/release/reclaim/consume lifecycle, concurrent
claim binding, Redis server-time lease expiry, complete identity return, and
strict unknown-field rejection inside the production Lua scripts.

The complete nine-file focused suite is green:

```text
Test Files  9 passed (9)
Tests       82 passed (82)
```

`git diff --check` passes. Full API typecheck remains red in pre-existing
Task 12 worker/legacy test seams and is not represented as a Task 11 failure;
the focused route/protocol/OpenAPI suite is green.

## Review follow-up

The router now preserves the active stream and lease for typed fresh-run
post-acceptance reconciliation, short-circuits consumed/expired/claimed native
interactions before allocating resources, canonicalizes metadata comparison,
and enforces bounded message counts/content. OpenAPI now describes string or
structured Anvia messages, approval-only staging, and `anyOf` overrides.

The interaction policy store exposes a crash-safe `claim`/`consume`/`release`
worker seam with owner/tool/response binding and Redis server-time leases;
terminal records reject retained executable fields and Lua rejects unknown
states. Task12 now consumes the public claim seam; no destructive `take`
implementation/export remains. The authorized real-Redis run passed 5/5 policy
tests; the restricted sandbox attempt itself was denied with
`EPERM 127.0.0.1:16379`. The current focused route/queue/OpenAPI suite is
green at 47/47 across six files, including the injected fresh/cursor/
interaction side-effect matrix.

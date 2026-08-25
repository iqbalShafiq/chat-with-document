# Anvia v1 Integration and Lifecycle Verification

**Verified:** 2026-08-25 06:56 WIB  
**Branch:** `feat/anvia-v1-migration`  
**Baseline commit:** `497176caef7df8a21c11c9f5e77b56bcb71f7f0a`  
**Anvia train:** exact `1.0.1`

## Scope and environment

The repository's normal Docker Compose and development entrypoints were used.
No parallel test stack was created. Credentials came from the existing project
`.env`; this report records only service addresses and never secret values.

| Service | Address | Result |
|---|---|---|
| Platform | `http://127.0.0.1:3000` | HTTP 200 |
| API health | `http://127.0.0.1:3001/health` | HTTP 200 |
| PostgreSQL 16 | `localhost:15433` | schema and native memory integration passed |
| Redis 7 | `localhost:16379` | interaction/policy Lua integration passed |
| Qdrant 1.19.0 | `http://localhost:16333` | HTTP 200, ensure/delete/close passed |

`prisma migrate deploy` found all 17 migrations applied and no pending
migration. The normal seed completed successfully. No Prisma migration or
destructive data conversion was added for the Anvia v1 cutover.

## Startup smoke

The stack was started with the repository's normal command:

```bash
pnpm dev
```

Observed startup invariants:

- Vite became ready on port 3000 without server-only module leakage.
- API became ready on port 3001.
- document ingest, profile summary, and chat-run BullMQ workers became ready.
- the worker's sanitized Prisma memory validation completed before chat-run
  readiness.
- platform, API health, and Qdrant collection endpoints returned HTTP 200.

## Native persistence and restart evidence

Focused real-service integration was run against the configured PostgreSQL and
Redis instances:

```bash
pnpm --filter api exec vitest run \
  src/modules/chat/interaction-store.redis.test.ts \
  src/modules/chat/interaction-policy-store.redis.test.ts \
  src/modules/chat/native-memory.integration.test.ts
```

Result: **3 files, 20 tests passed**.

This covers durable interaction suspension, exact-once claim/consume,
concurrent resume rejection, expiry/replay handling, session-bound policy
claims, atomic native memory prefix replacement, conflict preservation, and
fail-closed truncation after compaction.

The full API suite was also executed with `NODE_ENV=test` and the real service
URLs: **51 files passed, 447 tests passed, 1 explicitly gated real-LLM test
skipped by the ordinary suite**. The real-LLM test was executed separately as
described below.

## Real provider, compaction, and observability

No LLM stub was used for acceptance evidence.

1. Native `createSummaryMemoryCompactor()` called
   `deepseek/deepseek-v4-flash-0731` with reasoning `max`. The returned summary
   preserved the seeded project name, Indonesian preference, CSV source, and
   unresolved Q2/Q3 comparison. Result: **1/1 passed**.
2. A real Anvia v1 Agent streamed through the same DeepSeek model with
   reasoning `max` and a named Langfuse observer. Observed native events were
   `turn_start`, `generation_start`, `reasoning_delta`, `text_delta`,
   `turn_end`, and `response`; the exact response invariant passed and
   `LangfuseClient.close()` completed.

## Context7 lifecycle

Recipe resolution now consumes `CONTEXT7_TOOL_DEFINITIONS`, an immutable
JSON-only contract. It does not open an MCP transport. The live Context7
endpoint was queried in a process-owned smoke helper, its two tool definitions
matched the frozen contract byte-for-byte, and the transport was closed.

The chat worker remains the only owner of the live Context7 MCP connection. At
run reconstruction it compares the live definitions with the frozen recipe and
fails closed on schema drift.

The API `/capabilities` route reports this explicitly as `context7Configured`.
It
does not probe the endpoint or open a transport; live availability remains a
worker-owned, fail-closed run invariant. A source-wiring regression test guards
this process-ownership boundary.

## Qdrant compatibility defect and fix

The initial smoke exposed a real compatibility warning: Compose pinned Qdrant
server `1.13.2`, while Anvia's resolved JS client was `1.19.0`. Qdrant's client
accepts at most one minor of drift.

The Compose image was updated to `qdrant/qdrant:v1.19.0`, matching the resolved
client and the official `v1.19.0` release. After recreation, the lifecycle
smoke reported:

```text
qdrant_ensure=ok close_idempotent=ok
```

The dependency guard now compares the pinned Docker server major/minor with
the resolved `@qdrant/js-client-rest` major/minor and rejects incompatible
future drift.

## Graceful shutdown

`SIGTERM` was sent to the actual worker application process created by the
normal `pnpm dev` tree. The worker logged receipt of `SIGTERM`, completed its
shutdown coordinator, and exited without a shutdown failure, unclosed-handle
warning, or orphan-lease diagnostic. The stack then restarted cleanly and all
three queues returned to ready state.

The shutdown coordinator owns, in order, active runs, chat/document/profile
workers, Qdrant, Context7, Langfuse, Prisma, and Redis. Focused lifecycle tests
and the live provider/Qdrant/Context7 smokes verify the resources exercised in
this task.

## Decision and residual scope

Task 17 integration and lifecycle gates pass. Browser-level reload while
streaming, worker restart during a visible approval/question card, and the full
authenticated product matrix remain intentionally assigned to Task 18, where
they are exercised through the real browser and real DeepSeek model rather
than duplicated in a lower-fidelity harness.

Rollback remains application-only: the Anvia v1 branch can be replaced by the
pre-migration application without reversing a database migration. Runtime
messages created by native compaction retain Anvia's explicit metadata marker;
no destructive rewrite of historical sessions was introduced.

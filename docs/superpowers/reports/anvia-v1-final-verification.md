# Anvia v1 Final Verification

**Date:** 2026-08-25  
**Branch:** `feat/anvia-v1-migration`  
**Task 18 commit:** `3bdfb29` (`test(e2e): verify Anvia v1 product parity`)  
**Anvia train:** exact `@anvia/*` `1.0.1`  
**Target models for real E2E:** `deepseek/deepseek-v4-flash-0731`, reasoning `max`

## Package and schema

- Dependency guard: `node scripts/verify-anvia-v1-dependencies.mjs` passed.
- `pnpm install --frozen-lockfile` succeeded.
- Prisma: one additive migration on this branch,
  `20260824000000_add_context_claim_state` (nullable `claimId`/`claimedAt`
  columns + indexes). No destructive rewrite. Rolling back the application
  does not require reversing those columns.
- Offline v0 memory normalization remains a separate CLI; workers fail closed
  on unsanitized rows.

## Removed-API and import boundary

Runtime `packages/` and `apps/` do not call `AgentBuilder`, `ExtractorBuilder`,
`createChatTransport`, `createEventStream`, `createPrismaMemoryStore`,
`langfuse.create`, `connectMcp`, `mcp.http`, or `completionApi`. Remaining
mentions are tests that assert the legacy APIs are not invoked, the memory
normalizer that rejects v0 `additionalParams`, or historical docs.

`apps/platform/src` has no imports of `@anvia/openai`, `@anvia/mistral`,
`@anvia/qdrant`, `@anvia/langfuse`, `@anvia/mcp`, `@anvia/memory-prisma`, or
`@anvia/server`.

## Verification matrix (Task 19, fresh commands)

| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | pass |
| `pnpm --filter @assingment/agent test` | 28 files, 228 passed |
| `pnpm --filter @assingment/agent exec tsc --noEmit` | pass |
| `NODE_ENV=test` API vitest with `.env` | 51 files, 453 passed, 1 skipped (gated real-LLM memory test) |
| `pnpm --filter api build` | pass |
| `pnpm --filter platform test` | 24 files, 160 passed (before failed-tail helper; 6 extra tests added after) |
| `pnpm --filter platform exec tsc --noEmit` | pass after e2e/request-body and Deep Research typing fixes |
| `pnpm --filter platform build` | pass |
| deterministic Playwright `--retries=0 --workers=1` | **15/15 in 51.2s** |
| real-LLM Playwright `--retries=0 --workers=1` | serial **22/24 in 35.8m**; focused reruns of both failures **2/2 in 1.2m** |
| `prisma validate` | schema valid |
| `git diff --check` | pass |

The serial real-LLM failures were both queue-drain races: `waitForRunDone`
returned at the first idle `Send` while auto-flush still had follow-ups.
`waitForIdleComposer` now waits until `Send` is visible and the queued-message
list is gone. Focused reruns: queue edit/reorder 24.8s, composer follow-up 45.0s.

C12 and C13 both passed in the serial Task 19 run (6.7m and 6.5m).

## Data and rollback

- Existing sessions load; new messages append through native Prisma memory.
- Compaction remains Anvia-native; the UI never synthesizes summary markers.
- Failed-tail retry now awaits session freshness and truncate commit before
  sending the replacement prompt (fail-closed on `"unknown"` or truncate error).
- Rollback point: replace this branch with pre-migration `main`. No Prisma
  down-migration is required for application rollback.

## Independent review

See `docs/superpowers/reports/anvia-v1-task19-review.md`.

Accepted and fixed:

- **Issue 1 (bug):** composer failed-tail truncate was fire-and-forget and
  raced `sendDraft`. Truncate now requires proven freshness, awaits the
  server, and passes `expectedPrefixMessageCount`.

Accepted residual (not blockers for this report):

- **Issue 2 (suggestion):** claimed-interaction short-circuit can delay
  crash-reclaim until TTL. Live double-submit 409 is correct; expired-lease
  reclaim is a follow-up.
- **Issue 3 (suggestion):** recipe construction failures currently map to 404
  `CHAT_REQUEST_NOT_AUTHORIZED`. Operators cannot distinguish auth from
  backend outage.
- **Issue 4 (suggestion):** worker shutdown has no per-stage timeout.

## Residual risks

- A full serial 24/24 real-LLM invocation was not repeated after the idle-composer
  wait and failed-tail fixes. Focused reruns of the two serial failures passed.
- Image-generation Playwright permutations remain stub protocol coverage; live
  image generation is covered by one real-LLM case.
- Historical v0 sessions still need the offline sanitizer before a worker will
  load them.

## Merge options

This session does not merge or open a PR. Options:

1. Keep `feat/anvia-v1-migration` local until you review.
2. Push and open a PR against `main`.
3. Discard the branch; application rollback does not require data reversal.

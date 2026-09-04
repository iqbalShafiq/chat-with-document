# Anvia 1.0.x patch bump — verification

**Date:** 2026-09-04  
**Branch:** `feat/anvia-1.0-patch-bump` (from `feat/anvia-v1-migration` @ `d61bfba`)  
**Target model for real E2E:** `deepseek/deepseek-v4-flash-0731`, reasoning `max`

## Version table

| Package | Was | Now |
| --- | --- | --- |
| `@anvia/core` | 1.0.1 | 1.0.9 |
| `@anvia/openai` | 1.0.1 | 1.0.9 |
| `@anvia/mistral` | 1.0.1 | 1.0.9 |
| `@anvia/langfuse` | 1.0.1 | 1.0.9 |
| `@anvia/memory-prisma` | 1.0.1 | 1.0.9 |
| `@anvia/client` | 1.0.1 | 1.0.10 |
| `@anvia/server` | 1.0.1 | 1.0.10 |
| `@anvia/mcp` | 1.0.1 | 1.0.10 |
| `@anvia/qdrant` | 1.0.1 | 1.0.10 |
| `@anvia/react` | 1.0.1 | 1.0.11 |
| `@anvia/react-ui` | 1.0.1 | 1.0.11 |

`node scripts/verify-anvia-v1-dependencies.mjs` now pins a per-package map (packages no longer share one version).

## Prisma delta

Additive only: `AgentMemorySession.compactionState Json?`  
Migration: `apps/api/prisma/migrations/20260904000000_add_agent_memory_compaction_state/`

This is required by `@anvia/memory-prisma` 1.0.7. Canonical `load()` keeps full history; `compaction.snapshot()` returns the latest summary checkpoint plus the unsummarized tail.

App truncate (`truncateSessionMemory`) now writes `compactionState: Prisma.DbNull` so a user truncate cannot leave a stale checkpoint that skips deleted rows.

`prisma validate` passed. After Docker came up, `pnpm --filter @anreal/api db:deploy` applied `20260904000000_add_agent_memory_compaction_state`.

## Adapter deltas (types-backed)

- **Reasoning:** Agent 1.0.9 `controls` exists, but we keep `providerOptionsForReasoning` so DeepSeek `max` + `summary: "auto"` is unchanged. Native enum was not adopted.
- **MCP:** Context7 `McpClient` now sets `versionNegotiation: { mode: "auto" }` while keeping `ssrfProtection: "strict"`.
- **Eval 1.0.8:** `EvalMetricArgs.signal` is required; G-Eval context moved onto cases as `string[]`.
- **Qdrant / usage UI / graph explorer:** no product changes.

## Commands run

| Check | Result |
| --- | --- |
| `pnpm install` | pass |
| `node scripts/verify-anvia-v1-dependencies.mjs` | pass |
| `pnpm --filter @anreal/agent exec tsc --noEmit` | pass |
| `pnpm --filter @anreal/api exec tsc --noEmit` | pass |
| `pnpm --filter @anreal/platform exec tsc --noEmit` | pass |
| `pnpm --filter @anreal/agent test` | 28 files, 228 passed |
| `pnpm --filter @anreal/platform test` | 32 files, 191 passed |
| `pnpm --filter @anreal/api test -- src/modules/chat/truncate-memory.test.ts` | 6 passed |
| `pnpm --filter @anreal/api exec prisma validate` | pass |
| `pnpm --filter @anreal/api db:deploy` | applied `compactionState` |
| `pnpm --filter @anreal/api test` (full, Docker up) | **51 passed / 1 skipped**, 460 tests passed; native-memory integration + Redis Lua suites green |
| Playwright real-LLM | **not run** — still needs `pnpm dev` + OpenRouter key |

Vitest now injects `DATABASE_URL` from repo `.env` (in addition to `MISTRAL_API_KEY`) so the Prisma memory integration hits local Postgres without loading the rest of `.env` (which would break `origins.test.ts`).

## Real-LLM Playwright (to run locally)

Boot real OpenRouter stack (no stub):

```
pnpm dev
pnpm --filter @anreal/platform exec playwright test --config playwright.real-llm.config.ts --retries=0 --workers=1
```

New file: `apps/platform/e2e/anvia-patch.real-llm.e2e.ts` (picked up by existing `*real-llm*` match). Helpers still force `deepseek/deepseek-v4-flash-0731` + `max`.

## Residual risks

- Local DB must receive the additive migration before compaction/truncate against Postgres.
- Native reasoning `controls` were not wired; if OpenRouter later ignores `providerOptions.reasoning.effort`, revisit 1.0.9 controls without mapping `max` → `high`.
- Real-LLM Playwright still has known queue-drain races; use `waitForIdleComposer` on follow-up cases.

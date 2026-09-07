# Anvia v0 baseline

Date: 2026-08-23
Branch: `feat/anvia-v1-migration`
Worktree: `/Users/shafiq/.codex/visualizations/2026/08/23/01a02f0b-3f96-7971-894c-f3e9bd5e3f20/chat-with-document-anvia-v1`
Base commit: `f68a44e`

## Environment

- pnpm `10.30.3`
- Node runtime provided by the workspace
- Prisma client generated with `pnpm --filter api db:generate`
- No repository `.env` is present in the isolated worktree; baseline API tests used `MISTRAL_API_KEY=baseline-placeholder` only to satisfy module construction. No model call is asserted by the baseline suite.

## Results

| Check | Result | Evidence |
|---|---|---|
| `pnpm install --frozen-lockfile` | PASS | 730 packages installed; lockfile unchanged. |
| `pnpm --filter @assingment/agent test` | PASS | 18 files, 175 tests, 10.22s. |
| `pnpm --filter @assingment/agent exec tsc --noEmit` | BASELINE FAIL | Two existing `DeepResearchProgressReporter` callbacks in `src/tools/deep-research.test.ts` return `number` instead of `void` (TS2345 at lines 223 and 259). |
| `pnpm --filter api test` | PASS with local bind permission | 29 files, 255 tests, 3.31s. Executed with `MISTRAL_API_KEY=baseline-placeholder` and escalated local bind permission. |
| `pnpm --filter api build` | PASS | TypeScript build succeeds after Prisma client generation. |
| `pnpm --filter platform test` | PASS | 15 files, 102 tests, 1.31s. |
| `pnpm --filter platform build` | PASS | Vite production build succeeds; only existing chunk-size warning. |
| `git diff --check` | PASS | No whitespace errors. |

## Sandbox note

The API E2E suite cannot bind `127.0.0.1` under the default sandbox (`EPERM`). The same suite passes with escalated local execution, so this is an execution-policy limitation rather than a product baseline failure.

## Migration starting point

The repository currently references Anvia v0 packages (`@anvia/core` 0.26.x, `@anvia/react` 0.11.x, `@anvia/server` 0.7.x, and related packages). The next task upgrades the graph as one exact `1.0.0` train and records the expected compile-red categories.

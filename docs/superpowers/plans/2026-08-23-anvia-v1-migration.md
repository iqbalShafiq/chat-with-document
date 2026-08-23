# Anvia v1 Stable Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the complete application from its current Anvia v0 package set to the synchronized Anvia v1.0.0 train while preserving every current chat, retrieval, approval, clarification, queue, Deep Research, memory, citation, and UI behavior.

**Architecture:** Perform one synchronized cutover on an isolated `feat/anvia-v1-migration` worktree, using application-owned adapters around v1 Agent construction, protocol-v3 queue streaming, durable native approval continuations, and React transport/interactions. Keep the richer custom clarification flow as a tested compatibility island. Deploy only after the entire vertical path and regression matrix pass.

**Tech Stack:** TypeScript, pnpm workspaces, Anvia v1.0.0, React 19/Vite, Hono, BullMQ, Redis/ioredis, Prisma 7/Postgres, Qdrant, Langfuse, MCP, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-anvia-v1-migration-design.md`

## Global Constraints

- Start from clean, current `main`; create a new branch using the repository convention: `feat/anvia-v1-migration`.
- Use `superpowers:using-git-worktrees` before implementation. Suggested isolated path: `/Users/shafiq/VsCodeProjects/chat-with-document-anvia-v1`.
- Do not develop on `main` or reuse `feat/data-analysis-deep-research`.
- Upgrade all Anvia packages to exactly `1.0.0` in one dependency graph; do not leave mixed v0/v1 packages or permissive ranges during migration.
- After Task 2, full API and platform compilation is intentionally RED until their remaining v0 boundaries are migrated in Tasks 12 and 15. Intermediate tasks must run their focused tests and the narrowest compilable package; do not claim a full workspace build is green early.
- Follow `superpowers:test-driven-development`: demonstrate each focused RED failure before production edits, implement the smallest coherent GREEN change, then refactor while green.
- On any unexpected failure, invoke `superpowers:systematic-debugging` before changing code. Record root cause; do not weaken assertions to hide provider/protocol flakes.
- Preserve unrelated user changes. Stage exact intended-file allowlists for every commit.
- No Prisma migration is expected. Run schema compatibility checks; add an additive/backward-compatible migration only if the check proves a delta.
- Never serialize secrets, client instances, Prisma handles, or provider SDK objects into Redis/BullMQ/continuations.
- Do not remove queued follow-ups, editable image approvals, custom multi-select clarification, app compaction, citations, or Deep Research behavior to make the upgrade easier.
- Before claiming completion use `superpowers:verification-before-completion`, then `superpowers:requesting-code-review` and `superpowers:finishing-a-development-branch`.

---

### Task 1: Create the isolated branch and capture a v0 baseline

**Files:**
- Create: `docs/superpowers/reports/anvia-v1-baseline.md`
- Verify only: `package.json`, `pnpm-lock.yaml`, `packages/agent/package.json`, `apps/api/package.json`, `apps/platform/package.json`

**Interfaces:**
- Consumes: clean `main` at the latest approved remote state.
- Produces: isolated worktree on `feat/anvia-v1-migration` and a reproducible baseline report.

- [ ] **Step 1: Verify current workspace and branch convention**

Run from the current repository:

```bash
git status --short
git branch --show-current
git log --oneline --decorate -12
```

Expected: clean `main`; recent feature branches use `feat/*`. If dirty, stop and preserve the user's work before creating the worktree.

- [ ] **Step 2: Create the branch in an isolated worktree**

```bash
git fetch origin
git worktree add /Users/shafiq/VsCodeProjects/chat-with-document-anvia-v1 -b feat/anvia-v1-migration main
git -C /Users/shafiq/VsCodeProjects/chat-with-document-anvia-v1 status --short --branch
```

Expected: new worktree reports `## feat/anvia-v1-migration` and no changes, and contains this committed spec/plan from local `main`. If `origin/main` moved, reconcile local `main` safely before creating the worktree; do not drop the planning commit.

- [ ] **Step 3: Install and run the existing baseline**

```bash
pnpm install --frozen-lockfile
pnpm --filter @assingment/agent test
pnpm --filter @assingment/agent exec tsc --noEmit
pnpm --filter api test
pnpm --filter api build
pnpm --filter platform test
pnpm --filter platform build
git diff --check
```

Expected: all existing checks pass before the SDK migration. Record exact counts, durations, and any environment-dependent exclusions in `docs/superpowers/reports/anvia-v1-baseline.md`.

- [ ] **Step 4: Commit the baseline report**

```bash
git add docs/superpowers/reports/anvia-v1-baseline.md
git commit -m "docs: capture Anvia v0 migration baseline"
```

### Task 2: Add a synchronized Anvia v1 dependency contract

**Files:**
- Create: `scripts/verify-anvia-v1-dependencies.mjs`
- Modify: `package.json`
- Modify: `packages/agent/package.json`
- Modify: `apps/api/package.json`
- Modify: `apps/platform/package.json`
- Modify: `pnpm-lock.yaml`
- Modify later in this task: `patches/@anvia__react-ui.patch`

**Interfaces:**
- Consumes: package manifests and lock graph.
- Produces: exact 1.0.0 Anvia graph, direct `@anvia/client`/`@anvia/mcp` ownership, and a machine-enforced guard.

- [ ] **Step 1: Write the failing dependency guard**

The script must inspect all workspace manifests and the lockfile, require every referenced `@anvia/*` package to resolve to `1.0.0`, require `@anvia/client` in API/platform, require `@anvia/mcp` in agent, reject legacy versions, and confirm the React UI patch points at v1.

```bash
node scripts/verify-anvia-v1-dependencies.mjs
```

Expected RED: reports current Core 0.26/React 0.11/etc. and missing client/MCP packages.

- [ ] **Step 2: Update manifests as one package train**

Target direct dependencies:

```text
packages/agent: @anvia/core, @anvia/langfuse, @anvia/mistral,
                @anvia/openai, @anvia/qdrant, @anvia/mcp = 1.0.0
apps/api:      @anvia/core, @anvia/client, @anvia/memory-prisma,
                @anvia/server = 1.0.0
apps/platform: @anvia/client, @anvia/react, @anvia/react-ui = 1.0.0
```

Use exact versions, not carets, during migration.

Before installing, remove the old v0 `patchedDependencies` mapping from `package.json` with `apply_patch`; leave the old patch file recoverable in git until the v1 patch is finished.

- [ ] **Step 3: Regenerate the lockfile and recreate the UI patch**

```bash
pnpm install
pnpm patch @anvia/react-ui@1.0.0
```

Reapply only the two product requirements against v1 built output: composer remains editable and submit-capable while the chat is submitted/streaming so the app can queue follow-ups. Finish with the path printed by pnpm, replace the old patch file/mapping with the new one using `apply_patch`, and reinstall with `--frozen-lockfile`. Do not copy the old patch blindly.

- [ ] **Step 4: Prove dependency GREEN and capture compile RED**

```bash
node scripts/verify-anvia-v1-dependencies.mjs
pnpm list -r --depth 0
pnpm why -r @anvia/core
pnpm --filter @assingment/agent exec tsc --noEmit
```

Expected: guard passes; TypeScript fails only on the inventoried removed v0 APIs. Save the compiler categories in the task notes before fixing them.

- [ ] **Step 5: Commit dependency cutover**

```bash
git add package.json packages/agent/package.json apps/api/package.json apps/platform/package.json pnpm-lock.yaml patches/@anvia__react-ui.patch scripts/verify-anvia-v1-dependencies.mjs
git commit -m "build: synchronize Anvia packages on v1"
```

### Task 3: Migrate provider factories and process-owned observability

**Files:**
- Modify: `packages/agent/src/providers/openai.ts`
- Create: `packages/agent/src/providers/openai.test.ts`
- Modify: `packages/agent/src/providers/mistral.ts`
- Create: `packages/agent/src/providers/mistral.test.ts`
- Modify: `packages/agent/src/providers/image-generation.ts`
- Modify: `packages/agent/src/providers/image-generation.test.ts`
- Modify: `packages/agent/src/tracing.ts`
- Create: `packages/agent/src/tracing.test.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `apps/api/src/worker.ts`

**Interfaces:**
- Consumes: env-backed provider settings and selected model/reasoning effort.
- Produces: v1 model handles, strict provider options, named Langfuse observer, and explicit close hooks.

- [ ] **Step 1: Write RED provider contract tests**

Assert OpenAI construction excludes removed `completionApi`, calls `completionModel({ modelId, api: "responses" })`, and supplies reasoning as `{ reasoning: { effort, summary: "auto" } }` provider options. Assert Mistral embedding/OCR use object-only model ids and dimensions. Assert image generation still maps current product settings.

```bash
pnpm --filter @assingment/agent test -- src/providers/openai.test.ts src/providers/mistral.test.ts src/providers/image-generation.test.ts
```

Expected RED: positional factories and old completion wrapper fail.

- [ ] **Step 2: Implement v1 provider handles**

Remove the hand-written `CompletionModel.completion` wrapper. Return a v1 streaming completion model from the OpenAI client and expose a pure `providerOptionsForReasoning(effort)` helper for Agent construction. Set an explicit official Mistral OCR model id in configuration rather than calling `ocrModel()` without arguments.

- [ ] **Step 3: Write RED Langfuse ownership test**

Require one lazily owned `LangfuseClient`, `observer()` access, no `langfuse.create`, and an idempotent async `closeTracing()`.

- [ ] **Step 4: Implement and wire lifecycle cleanup**

Use named agent observability later as `{ observers: { langfuse: tracing.observer() } }`. Export close/flush and call it from the worker's existing signal/finally shutdown path without swallowing timeout diagnostics.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @assingment/agent test -- src/providers src/tracing.test.ts
git add packages/agent/src/providers packages/agent/src/tracing.ts packages/agent/src/tracing.test.ts packages/agent/src/index.ts apps/api/src/worker.ts
git commit -m "refactor(agent): migrate providers and tracing to Anvia v1"
```

### Task 4: Migrate Qdrant retrieval and Context7 MCP ownership

**Files:**
- Modify: `packages/agent/src/qdrant/chunk-store.ts`
- Create: `packages/agent/src/qdrant/chunk-store.test.ts`
- Modify: `packages/agent/src/tools/context7.ts`
- Create: `packages/agent/src/tools/context7.test.ts`
- Modify: `apps/api/src/lib/context7-server.ts`
- Modify: `apps/api/src/worker.ts`
- Modify: `packages/agent/src/index.ts`

**Interfaces:**
- Consumes: Qdrant URL, embedding model, Context7 URL/key.
- Produces: process-owned v1 vector and MCP clients, stable retrieval service, server registrations, and close hooks.

- [ ] **Step 1: Write RED Qdrant adapter tests**

Use fake native Qdrant delegates to assert `ensure()` on first use, replacement upsert, deletion, ownership/document filters, logical `topK`, score ordering, stable chunk metadata, missing-collection behavior, and idempotent close.

```bash
pnpm --filter @assingment/agent test -- src/qdrant/chunk-store.test.ts
```

Expected RED: v0 `QdrantVectorStore.connect/index/upsertDocuments` does not satisfy the contract.

- [ ] **Step 2: Implement v1 Qdrant lifecycle**

Create one `QdrantVectorClient`, derive the dense store with `{ collectionName, dimensions, metric: "cosine" }` using the exact tagged option names, call `ensure`, use `upsert({ documents })`, and adapt query embedding/search to the official v1 retrieval helper or store request. Keep explicit native deletion only if the public v1 store cannot express the current metadata delete; document and test that boundary.

- [ ] **Step 3: Write RED MCP tests**

Assert a `McpClient` from `@anvia/mcp` uses Streamable HTTP, strict SSRF protection, explicit authorization headers, connects once, degrades to `null` on configured remote failure, and closes once on shutdown.

- [ ] **Step 4: Implement Context7 client ownership**

Replace Core `connectMcp/mcp.http`. Return both the Core `McpServer` registration and a close owner or expose `closeContext7Mcp()`. Keep `getContext7McpServer()` process-cached and avoid putting secrets in the registration/recipe.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter @assingment/agent test -- src/qdrant/chunk-store.test.ts src/tools/context7.test.ts
git add packages/agent/src/qdrant packages/agent/src/tools/context7.ts packages/agent/src/tools/context7.test.ts packages/agent/src/index.ts apps/api/src/lib/context7-server.ts apps/api/src/worker.ts
git commit -m "refactor(agent): migrate retrieval and MCP to Anvia v1"
```

### Task 5: Convert all tools and nested Deep Research contracts

**Files:**
- Modify: `packages/agent/src/tools/*.ts`
- Modify: `packages/agent/src/tools/tabular/tools.ts`
- Modify: `packages/agent/src/profiling/profile-tool.ts`
- Create: `packages/agent/src/profiling/profile-tool.test.ts`
- Modify: existing `packages/agent/src/tools/**/*.test.ts`
- Modify: `packages/agent/src/tools/deep-research.test.ts`
- Modify: `packages/agent/src/evals/stub-scopes.ts`

**Interfaces:**
- Consumes: scoped application services, grants, overrides, cancellation, and progress callbacks.
- Produces: strict v1 Tool contracts and a bounded non-suspending nested researcher.

- [ ] **Step 1: Add a source guard and focused RED tests**

Add a test/helper that rejects legacy tool option keys (`input`, `output`, `approval`) in `packages/agent/src`. Update representative lookup, mutation, image, tabular, clarification, and Deep Research tests to expect `inputSchema`, `outputSchema`, strict JSON/`ToolOutput.content`, and `requiresApproval`.

```bash
pnpm --filter @assingment/agent test -- src/tools src/profiling/profile-tool.test.ts
```

Expected RED: legacy option keys and rich output shapes fail.

- [ ] **Step 2: Convert deterministic and retrieval tools**

Migrate document, web, data-analysis, tabular, Context7-facing, and profile tools. Preserve descriptions, caps, authorization services, citation marker/trailer, image/file result rendering, and SQL read-only guarantees.

- [ ] **Step 3: Convert approval-aware image/web/research tools**

Use scoped async `requiresApproval(args, context)` to consult session grants. Keep validated override consumption inside `execute` so a native approval response cannot tamper with tool input. Ensure reject output remains safe and deterministic.

- [ ] **Step 4: Preserve clarification as an explicit compatibility tool**

Convert only its schema/output surface to v1. Keep `ClarificationToolScope.requester`, multiple choice, optional skip, recommendations, timeout, and custom Redis wait. Add a test proving it is not registered as a v1 `createQuestionTool` until product semantics can be represented.

- [ ] **Step 5: Fix Deep Research delegation**

Construct the child with v1 Agent APIs; expose it through `asTool({ name, description, maxTurns, stream: true, suspension: "reject" })`; omit recursive tools; keep search/turn budgets and citation requirements. Test that a child suspension becomes a bounded tool failure rather than a leaked continuation.

- [ ] **Step 6: Run GREEN and commit**

```bash
pnpm --filter @assingment/agent test -- src/tools src/profiling
git add packages/agent/src/tools packages/agent/src/profiling packages/agent/src/evals/stub-scopes.ts
git commit -m "refactor(agent): migrate tools to Anvia v1 contracts"
```

### Task 6: Replace AgentBuilder, structural messages, and direct generation APIs

**Files:**
- Modify: `packages/agent/src/agent.ts`
- Create: `packages/agent/src/agent.test.ts`
- Modify: `packages/agent/src/document/summaries.ts`
- Modify: `packages/agent/src/profiling/profile-summarizer.ts`
- Modify: `packages/agent/src/evals/run-agent.ts`
- Modify: `packages/agent/src/evals/run-agent.test.ts`
- Modify: `packages/agent/src/evals/behavior-target.ts`
- Modify: `packages/agent/src/evals/behavior-target.test.ts`
- Modify: `packages/agent/src/runner-dev.ts`

**Interfaces:**
- Consumes: model handle, instruction fragments, Documents/VectorContext, tools/MCP, memory, observer, provider options.
- Produces: stable-id scoped `Agent`, discriminated outcomes, v1 eval/direct generation targets.

- [ ] **Step 1: Write RED construction/outcome tests**

Assert one stable `chat-agent` id, concatenated deterministic instructions, supported `Document|VectorContext` only, bounded turns, named observer, `memory: { store, savePolicy }`, provider options, and explicit handling of `response|interaction|blocked`.

- [ ] **Step 2: Implement `new Agent({...})` factory**

Remove all builder chains and repeated mutable `.instructions/.context` calls. Keep dependency injection and ensure a scoped factory creates no cross-user mutable state.

- [ ] **Step 3: Migrate summaries and profile generation**

Use final v1 `generateCompletion`/`extract({...})` exports as appropriate, with strict structural messages and schemas. Preserve existing output cleanup, language, token budgets, and provider-free tests.

- [ ] **Step 4: Migrate eval targets**

Use object-only agent calls and explicit interaction responder policies. Tests must distinguish successful, blocked, suspended, rejected, and error outcomes; no eval may hang waiting for input.

- [ ] **Step 5: Prove no removed runtime APIs remain**

```bash
rg -n "AgentBuilder|ExtractorBuilder|\.session\(|\.prompt\(|withTrace\(|additionalParams|Message\.|UserContent\." packages apps
pnpm --filter @assingment/agent test
pnpm --filter @assingment/agent exec tsc --noEmit
```

Expected: `rg` finds only migration docs/tests that intentionally mention removed names; tests/typecheck pass for the agent workspace.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src
git commit -m "refactor(agent): adopt Anvia v1 agents and messages"
```

### Task 7: Adapt Prisma memory and prove data compatibility

**Files:**
- Modify: `apps/api/src/modules/chat/build-run-input.ts`
- Modify: `apps/api/src/modules/chat/memory-sanitizer.ts`
- Modify: `apps/api/src/modules/chat/memory-sanitizer.test.ts`
- Modify: `apps/api/src/modules/chat/compaction.ts`
- Modify: `apps/api/src/modules/chat/compaction.test.ts`
- Modify: `apps/api/src/modules/chat/enrich-memory-messages.ts`
- Modify: `apps/api/src/modules/chat/strip-user-attachments.ts`
- Modify: `apps/api/src/modules/chat/session-snapshot.ts`
- Modify: related chat/profile/session tests
- Verify: `apps/api/prisma/schema.prisma`

**Interfaces:**
- Consumes: existing `AgentMemory*` rows and session/user identity.
- Produces: v1 `PrismaMemoryStore`, `MemoryScope` calls, strict-message compaction/snapshots, no data loss.

- [ ] **Step 1: Add RED memory compatibility tests**

Seed representative existing user, assistant, tool, reasoning, attachment, citation, compacted-summary, and failed-run rows. Assert v1 store load, append, clear, retry cleanup, session snapshot, and profile inputs preserve required content and ownership.

- [ ] **Step 2: Construct and validate v1 store**

Replace removed factory with `new PrismaMemoryStore({ client: prisma, ... })`, expose one startup validation, use `{ scope: { sessionId, userId } }`, and keep the existing custom scope-key behavior only if byte-for-byte compatible.

- [ ] **Step 3: Reconcile compaction deliberately**

Keep application compaction enabled and Anvia automatic compaction disabled. Update all message parsing/building to strict v1 structures. Prove tool-call/result adjacency, citations, client message ids, attachment stripping, and summary divider behavior.

- [ ] **Step 4: Verify schema compatibility before any migration**

```bash
pnpm --filter api exec prisma validate
pnpm --filter api db:generate
git diff --exit-code -- apps/api/prisma/schema.prisma
```

Compare the three `AgentMemory*` models with the official v1 memory-prisma schema. Expected: no schema change; the app's extra `[userId, updatedAt]` index remains additive. If a real delta appears, stop, add a RED migration test, and design an additive/backward-compatible migration before proceeding.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter api test -- src/modules/chat/memory-sanitizer.test.ts src/modules/chat/compaction.test.ts src/modules/chat/session-snapshot.test.ts
git add apps/api/src/modules/chat apps/api/prisma/schema.prisma
git commit -m "refactor(api): adapt durable memory to Anvia v1"
```

### Task 8: Define a serializable run recipe and discriminated queue jobs

**Files:**
- Create: `apps/api/src/modules/chat/run-recipe.ts`
- Create: `apps/api/src/modules/chat/run-recipe.test.ts`
- Modify: `apps/api/src/modules/chat/run-queue.ts`
- Create: `apps/api/src/modules/chat/run-queue.test.ts`
- Modify: `apps/api/src/modules/chat/build-run-input.ts`
- Modify: existing wiring tests in `apps/api/src/modules/chat/*-wiring.test.ts`

**Interfaces:**
- Consumes: authenticated session/user, model/settings, resolved context/document ids, feature flags.
- Produces: strict-JSON `ChatAgentRecipe` and `ChatRunJobData = StartRunJob | ResumeRunJob`.

- [ ] **Step 1: Write RED recipe tests**

Require schema validation, deterministic reconstruction fields, stable `chat-agent` id, and rejection of credentials, functions, clients, Prisma records, or non-JSON values. Round-trip recipes through `JSON.stringify/parse`.

- [ ] **Step 2: Write RED queue union tests**

`start` jobs carry prompt plus recipe inputs. `resume` jobs carry continuation, official parsed response, recipe, and source interaction id. Both carry stream/session/user identity; neither carries secrets.

- [ ] **Step 3: Implement recipe building/reconstruction boundary**

Split `buildChatRunInput` into (a) authenticated resolution that creates a recipe and consumes single-use context and (b) live factory reconstruction from recipe plus process services. Ensure resume reconstructs compatible instructions/tools/MCP/memory without re-consuming context or relinking documents.

- [ ] **Step 4: Run GREEN and commit**

```bash
pnpm --filter api test -- src/modules/chat/run-recipe.test.ts src/modules/chat/run-queue.test.ts src/modules/chat/*-wiring.test.ts
git add apps/api/src/modules/chat/run-recipe.ts apps/api/src/modules/chat/run-recipe.test.ts apps/api/src/modules/chat/run-queue.ts apps/api/src/modules/chat/run-queue.test.ts apps/api/src/modules/chat/build-run-input.ts apps/api/src/modules/chat/*-wiring.test.ts
git commit -m "refactor(api): add resumable Anvia v1 run recipes"
```

### Task 9: Build the protocol-v3 Redis stream adapter

**Files:**
- Modify: `apps/api/src/lib/resumable-stream-store.ts`
- Create: `apps/api/src/lib/resumable-stream-store.test.ts`
- Create: `apps/api/src/modules/chat/client-events.ts`
- Create: `apps/api/src/modules/chat/client-events.test.ts`

**Interfaces:**
- Consumes: v1 `AgentStreamEvent` plus app progress/queue events.
- Produces: validated `ClientResumableEvent<ChatMetadata, ChatDataMap>` records and a pure worker adapter with protocol `anvia.client.v3`.

- [ ] **Step 1: Write RED resumable-store protocol tests**

Assert open/append/subscribe/status/close against the official `ResumableStreamStore<ClientResumableEvent>` interface, contiguous ids, running/completed/error state, TTL, sentinel handling, and rejection of legacy untagged records.

- [ ] **Step 2: Write RED event-mapping tests**

Standard agent events must pass through `agentToClientStream`. Deep Research progress, queue acknowledgement, and app compaction map through `customAgentEventsToClientStream` to named, strict-JSON data events with runtime schemas. Usage, citations, tool state, interaction, blocked, error, and terminal events must remain standard.

- [ ] **Step 3: Implement pure translation and storage adapters**

Implement a helper that accepts agent/custom events plus an awaited `onInteraction(outcome)` callback, produces canonical client events, and appends protocol envelopes through the official store interface. Prove callback ordering: `onInteraction` resolves before the interaction/suspended events are yielded. The actual Redis interaction persistence and worker integration land in Tasks 10 and 12.

- [ ] **Step 4: Specify tap placement without duplicating events**

Add tests/typed boundaries showing provider-detail taps run before canonical mapping while UI data events run after it. Ensure the adapter exposes terminal status so later worker integration can refresh profile only for a response, never interaction/blocked/error.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter api test -- src/lib/resumable-stream-store.test.ts src/modules/chat/client-events.test.ts
git add apps/api/src/lib/resumable-stream-store.ts apps/api/src/lib/resumable-stream-store.test.ts apps/api/src/modules/chat/client-events.ts apps/api/src/modules/chat/client-events.test.ts
git commit -m "feat(api): emit Anvia v1 client protocol from workers"
```

### Task 10: Implement durable native approval continuation storage

**Files:**
- Create: `apps/api/src/modules/chat/interaction-store.ts`
- Create: `apps/api/src/modules/chat/interaction-store.test.ts`
- Modify: `apps/api/src/modules/chat/approval-registry.ts`
- Modify: `apps/api/src/modules/chat/approval-registry.test.ts`
- Modify: `apps/api/src/modules/chat/run-queue.ts`

**Interfaces:**
- Consumes: `AgentInteractionRequest`, `AgentContinuation`, `ChatAgentRecipe`, authenticated response.
- Produces: owned, expiring, atomically claimable interaction records and resume jobs.

- [ ] **Step 1: Write RED state-machine tests**

Cover `put -> pending -> claim -> consumed`, enqueue-failure release, expiry, wrong user/session, request/response type mismatch, duplicate response, replay after consume, process recreation with the same Redis data, and JSON validation through official parsers.

- [ ] **Step 2: Implement `InteractionStore`**

Use explicit Redis keys and TTL. Store request, continuation, recipe, source stream/run, user/session, timestamps, and state. Use Lua or WATCH/MULTI for atomic claim/consume/release; never use get-then-set races.

- [ ] **Step 3: Split native approvals from compatibility registry**

Remove blocking approval handlers from worker Agent configuration. Keep only app-owned session grants, staged argument overrides, and custom clarification wait/response records in `approval-registry.ts`. Add comments/tests explaining the boundary.

- [ ] **Step 4: Expose persistence for the worker adapter**

Implement the `onInteraction(outcome, recipe, ownership)` function consumed by Task 9's adapter. Its test must prove persistence completes before the callback resolves and failure rejects the adapter path; Task 12 wires it into the real worker so a failed write becomes an error terminal instead of a non-resumable approval card.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter api test -- src/modules/chat/interaction-store.test.ts src/modules/chat/approval-registry.test.ts
git add apps/api/src/modules/chat/interaction-store.ts apps/api/src/modules/chat/interaction-store.test.ts apps/api/src/modules/chat/approval-registry.ts apps/api/src/modules/chat/approval-registry.test.ts apps/api/src/modules/chat/run-queue.ts
git commit -m "feat(api): persist Anvia v1 approval continuations"
```

### Task 11: Migrate the chat API to canonical requests, framing, and resume

**Files:**
- Modify: `apps/api/src/modules/chat/router.ts`
- Create: `apps/api/src/modules/chat/client-request.ts`
- Create: `apps/api/src/modules/chat/client-request.test.ts`
- Create: `apps/api/src/modules/chat/client-protocol.test.ts`
- Create: `apps/api/src/modules/chat/interaction-resume.test.ts`
- Modify: `apps/api/src/openapi/paths/chat.ts`
- Modify: `apps/api/src/openapi/components.ts`
- Modify: chat body/steer/session tests as required

**Interfaces:**
- Consumes: canonical messages, interaction response, resume cursor, validated product metadata.
- Produces: authorized queue jobs and protocol-v3 JSONL responses.

- [ ] **Step 1: Write RED request parsing tests**

Parse exactly three paths: new `messages`, canonical `interaction_response`, and request with `resume` cursor. Validate product metadata separately. Reject mixed/unknown fields, malformed strict messages, invalid image settings, unsupported model, and unauthorized document/session ids.

- [ ] **Step 2: Write RED protocol response tests**

Assert `x-anvia-stream-protocol`, JSONL content type, `stream_start`, contiguous ids, `stream_end`, resume after N, missing/stale stream, wrong-user ownership, and no raw legacy events.

- [ ] **Step 3: Implement new-message route**

Authorize, build recipe, acquire session lease, open stream metadata, enqueue `kind:"start"`, and return `resumeClientStreamResponse({ streamId, after: 0, store })`. Roll back lease/stream cleanly if enqueue fails.

- [ ] **Step 4: Implement cursor resume route path**

Authorize `streamId` against stored metadata and session, then call `resumeClientStreamResponse({ streamId, after, store })`. Do not enqueue duplicate work.

- [ ] **Step 5: Implement interaction response route path**

Parse/validate official response, atomically claim owned interaction, create/open a new stream, enqueue `kind:"resume"`, mark consumed after acceptance, and return the new stream subscription. Stage session grant/image override through the existing authorized endpoint before this canonical call.

- [ ] **Step 6: Keep steering/stop/custom clarification routes explicit**

Steer and stop remain app routes with current ownership rules. Old `/approval` execution should be narrowed to grant/override staging or removed after callers migrate. Clarification response remains its compatibility route.

- [ ] **Step 7: Update OpenAPI, run GREEN, commit**

```bash
pnpm --filter api test -- src/modules/chat/client-request.test.ts src/modules/chat/client-protocol.test.ts src/modules/chat/interaction-resume.test.ts src/openapi
git add apps/api/src/modules/chat apps/api/src/openapi
git commit -m "feat(api): serve canonical Anvia v1 chat streams"
```

### Task 12: Migrate worker execution, steering, stop, retry, and shutdown

**Files:**
- Modify: `apps/api/src/modules/chat/run-worker.ts`
- Modify: `apps/api/src/modules/chat/steering.ts`
- Modify: `apps/api/src/modules/chat/steer-sync.ts`
- Modify: `apps/api/src/modules/chat/steer-sync.test.ts`
- Modify: `apps/api/src/modules/chat/steering.test.ts`
- Modify: `apps/api/src/worker.ts`
- Create/modify: `apps/api/src/modules/chat/run-worker.test.ts`
- Modify: `apps/api/src/modules/chat/client-events.ts`
- Modify: `apps/api/src/modules/chat/interaction-store.ts`

**Interfaces:**
- Consumes: start/resume job union and live Redis steering/stop signals.
- Produces: one owned v1 `AgentStream` per attempt, correct completion/suspension/blocked/error cleanup.

- [ ] **Step 1: Extend RED worker tests**

Cover start call shape, resume call shape, stream `.steer({prompt|messages})`, queued acknowledgement only after `steering_applied`, stop cancellation, suspended lease release, blocked terminal behavior, transient pre-visible model-not-found retry once, and no retry after visible output.

- [ ] **Step 2: Replace PromptRequest with AgentStream**

Delete `.session().prompt().withTrace()` and `SteerableRequest` wrappers. Hold the v1 stream handle, feed the SteeringPump into `.steer`, and connect cancellation to `.cancel()` plus abort signals.

Wire Task 9's protocol adapter and Task 10's `onInteraction` persistence into this stream. Await continuation persistence before emitting the interaction event, then close/release the suspended run without blocking a worker.

- [ ] **Step 3: Rebuild retry safely**

Create a fresh Agent/AgentStream only if the first terminal event is the recognized transient failure and nothing was appended to the client stream. Remove exactly the failed strict prompt row using v1 scope/client message id, then requeue unapplied steer entries once.

- [ ] **Step 4: Implement bounded process shutdown**

Stop accepting jobs, cancel active handles, close BullMQ, then close Context7 MCP, Qdrant, Langfuse, Prisma, and Redis using exported idempotent hooks. Test signal registration and close ordering with fakes.

- [ ] **Step 5: Run GREEN and commit**

```bash
pnpm --filter api test -- src/modules/chat/run-worker.test.ts src/modules/chat/steer-sync.test.ts src/modules/chat/steering.test.ts
pnpm --filter api build
git add apps/api/src/modules/chat apps/api/src/worker.ts
git commit -m "refactor(api): execute Anvia v1 streams in BullMQ"
```

### Task 13: Add the platform v1 transport and request metadata adapter

**Files:**
- Create: `apps/platform/src/lib/chat/anvia-transport.ts`
- Create: `apps/platform/src/lib/chat/anvia-transport.test.ts`
- Create: `apps/platform/src/lib/chat/client-data.ts`
- Create: `apps/platform/src/lib/chat/client-data.test.ts`
- Modify: `apps/platform/src/routes/index.tsx`
- Modify: `apps/platform/src/lib/chat/message-metadata.ts`

**Interfaces:**
- Consumes: v1 `ClientStreamRequest`, current session/model/feature refs, cookies.
- Produces: `createHttpClientTransport` request with validated app metadata and typed data schemas.

- [ ] **Step 1: Write RED transport tests**

Assert credentials included; messages and interaction responses retain canonical shape; current session/model/reasoning/feature/image settings are injected at send time; resume cursor is preserved; no provider secrets included; response without v3 header is rejected.

- [ ] **Step 2: Implement transport wrapper**

Use `createHttpClientTransport` with a custom `body` callback around `ClientStreamRequest`. Do not put per-request settings into persisted UI message metadata unless they are truly message data. Register runtime schemas for `deepResearchProgress`, `queuedMessageApplied`, and compaction data.

- [ ] **Step 3: Migrate `useChat` setup**

Remove old `createChatTransport`, hook `createRequest`, and hook `humanInput`. Keep initial messages and explicit session-scoped resume behavior. Update `handleChatEvent` to standard/data event discriminants rather than raw top-level custom types.

- [ ] **Step 4: Run GREEN and commit**

```bash
pnpm --filter platform test -- src/lib/chat/anvia-transport.test.ts src/lib/chat/client-data.test.ts
git add apps/platform/src/lib/chat apps/platform/src/routes/index.tsx
git commit -m "refactor(platform): adopt Anvia v1 client transport"
```

### Task 14: Migrate React/client types and React UI primitives

**Files:**
- Modify: every platform file importing `@anvia/react`/`@anvia/react-ui` returned by `rg -l '@anvia/' apps/platform/src`
- Modify: `apps/platform/src/components/composer/chat-composer.tsx`
- Modify: `apps/platform/src/components/chat/chat-message-row.tsx`
- Modify: `apps/platform/src/components/tool-activity-panel.tsx`
- Modify: platform chat helper tests
- Modify: `README.md`

**Interfaces:**
- Consumes: `@anvia/client` UI messages/parts and v1 React controller.
- Produces: type-safe v1 message rendering and `*Primitive` component tree with preserved UX.

- [ ] **Step 1: Capture compile RED by category**

```bash
pnpm --filter platform exec tsc --noEmit
rg -n "from \"@anvia/react\"|from \"@anvia/react-ui\"" apps/platform/src
```

Classify moved UI/protocol types separately from removed UI aliases; do not use broad `as unknown as` casts.

- [ ] **Step 2: Move types to `@anvia/client`**

Adapt message parts, tool output, attachments, sources, errors, metadata/data maps, and finalization helpers to v1 shapes. Add parser tests for generated images, web sources, document citations, interrupted tool states, and message text.

- [ ] **Step 3: Replace UI aliases with primitives**

Use exact v1 exports (`ThreadPrimitive`, `MessagePrimitive`, `ComposerPrimitive`, `HumanInputPrimitive`, etc.) while preserving DOM hooks, CSS classes, accessibility labels, mobile layout, tool cards, reasoning panels, attachments, DataTable/DataChart, and message actions.

- [ ] **Step 4: Verify the rebased composer patch contract**

Add a deterministic installed-file guard or component test proving editor and submit are not disabled solely by submitted/streaming status. Update README patch notes to v1 and explain queued-follow-up ownership.

- [ ] **Step 5: Run focused GREEN, record remaining interaction compile RED, and commit**

```bash
pnpm --filter platform test -- src/lib/chat
pnpm --filter platform exec tsc --noEmit
git add apps/platform/src README.md patches/@anvia__react-ui.patch package.json pnpm-lock.yaml
git commit -m "refactor(platform): migrate chat UI to Anvia v1 primitives"
```

Expected: focused message/primitive tests pass. Any remaining TypeScript failures are limited to the old approval/human-input integration removed in Task 15; record the exact list.

### Task 15: Migrate approval UI to unified interactions and preserve clarification

**Files:**
- Modify: `apps/platform/src/components/chat/approval-panel.tsx`
- Modify: `apps/platform/src/components/chat/clarification-panel.tsx`
- Modify: `apps/platform/src/hooks/use-clarifications.ts`
- Modify: `apps/platform/src/lib/api.ts`
- Create: `apps/platform/src/lib/chat/interaction-response.ts`
- Create: `apps/platform/src/lib/chat/interaction-response.test.ts`
- Modify: `apps/platform/src/routes/index.tsx`

**Interfaces:**
- Consumes: `chat.interactions.pending`, existing grants/override form, custom clarification events.
- Produces: canonical approval response after optional staging; unchanged rich clarification wizard.

- [ ] **Step 1: Write RED interaction mapping tests**

Test allow once, session grant, reject with reason, validated image override staging before approve, duplicate response disabled, API failure retains pending UI, wrong interaction type rejected, and no raw v0 `ToolApproval` assumptions.

- [ ] **Step 2: Implement native approval panel**

Read pending tool-approval requests from the v1 controller. For session grant/image edits, call the authorized staging endpoint first; only then call `respondToInteraction({ interactionId, response })`. Use `respondingInteractions` for pending state and preserve focus/error recovery.

- [ ] **Step 3: Keep clarification isolated and remove duplicate rendering**

Continue using the custom clarification hook/route and wizard schema. Ensure its events come through the typed data mapping or an explicitly separate compatibility source. Render exactly one `ClarificationPanel` and cover single/multiple/free/skip/timeout behavior.

- [ ] **Step 4: Run GREEN and commit**

```bash
pnpm --filter platform test -- src/lib/chat/interaction-response.test.ts src/lib/chat/clarification-wizard.test.ts
pnpm --filter platform build
git add apps/platform/src/components/chat apps/platform/src/hooks/use-clarifications.ts apps/platform/src/lib/api.ts apps/platform/src/lib/chat apps/platform/src/routes/index.tsx
git commit -m "feat(platform): resume Anvia v1 approval interactions"
```

### Task 16: Update behavior evals and add migration-wide regression contracts

**Files:**
- Modify: `packages/agent/src/evals/run-agent.ts`
- Modify: `packages/agent/src/evals/behavior-target.ts`
- Modify: `packages/agent/src/evals/suites/*.ts`
- Modify: `packages/agent/src/evals/**/*.test.ts`
- Create: `apps/api/src/modules/chat/anvia-v1-regression.test.ts`
- Create: `apps/platform/src/lib/chat/anvia-v1-regression.test.ts`

**Interfaces:**
- Consumes: final v1 agent/API/platform contracts.
- Produces: deterministic regression gates for every migration invariant before external E2E.

- [ ] **Step 1: Write RED eval outcome tests**

Add deterministic interaction responders for approval allow/reject and explicit assertions for `response`, `interaction`, and `blocked`. Prove Deep Research remains one level; rejection cannot trigger fallback retrieval approval; citation markers/trailer survive child-to-parent output; clarification-required tasks still call the custom tool.

- [ ] **Step 2: Add API regression matrix**

Cover normal message, stream resume, stop, transient retry, steering FIFO, active-run locking, session delete during queued work, profile/usage tap conditions, document/image single-use context, interaction process restart, and custom clarification timeout.

- [ ] **Step 3: Add platform pure regression matrix**

Cover standard/data event reduction, UI message conversion, generated images/files, source/citation parsing, queue acknowledgement, interrupted tool finalization, approval staging ordering, and clarification wizard state.

- [ ] **Step 4: Run focused and full GREEN**

```bash
pnpm --filter @assingment/agent test
pnpm --filter @assingment/agent exec tsc --noEmit
pnpm --filter api test
pnpm --filter api build
pnpm --filter platform test
pnpm --filter platform build
```

Fix every failure through systematic debugging. Do not move to browser tests with known unit/type/build failures.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/evals apps/api/src/modules/chat/anvia-v1-regression.test.ts apps/platform/src/lib/chat/anvia-v1-regression.test.ts
git commit -m "test: cover Anvia v1 migration invariants"
```

### Task 17: Run local infrastructure integration and lifecycle smoke tests

**Files:**
- Create: `docs/superpowers/reports/anvia-v1-integration.md`
- Modify only if a proven defect exists: relevant source/test files from prior tasks

**Interfaces:**
- Consumes: Postgres, Redis, Qdrant, configured provider/Mistral/Context7/Langfuse environment.
- Produces: verified startup, persistence, retrieval, suspension/resume, and graceful shutdown evidence.

- [ ] **Step 1: Start the repository's normal services**

Use existing project commands and `.env`; do not invent a parallel stack.

```bash
docker compose up -d
pnpm --filter api db:deploy
pnpm --filter api db:seed
pnpm dev
```

If the repository's compose/migration commands differ in the worktree, inspect package scripts and use those exact commands. Record ports and process ids in the report, never secrets.

- [ ] **Step 2: Smoke startup validation**

Verify API health, platform load, Prisma memory validation, Qdrant `ensure`, Context7 configured/degraded path, Langfuse observer initialization, and absence of browser server-only import errors.

- [ ] **Step 3: Exercise persistence/restart cases**

Run a message to active streaming, reload/resume it, suspend on approval, restart the chat worker, approve, and confirm the resumed run completes once. Restart again with an expired/replayed id and confirm stable rejection. Verify memory and transcript after API restart.

- [ ] **Step 4: Exercise lifecycle shutdown**

Send SIGTERM through the normal process manager/dev harness, verify bounded close logs and no orphan BullMQ lease/MCP connection/unclosed-handle test warning. Restart cleanly and run one more chat/retrieval request.

- [ ] **Step 5: Document and commit evidence**

Record commands, timestamps, anonymized ids, expected/actual behavior, and any fixed defects in `docs/superpowers/reports/anvia-v1-integration.md`.

```bash
git add docs/superpowers/reports/anvia-v1-integration.md
git commit -m "test: verify Anvia v1 service integration"
```

### Task 18: Automate and manually verify the real-browser acceptance matrix

**Files:**
- Modify: `apps/platform/e2e/real-llm.e2e.ts`
- Modify: `apps/platform/e2e/image-generation.e2e.ts`
- Modify: `apps/platform/e2e/data-analysis.real-llm.e2e.ts`
- Modify: `apps/platform/e2e/deep-research.real-llm.e2e.ts`
- Modify: `apps/platform/e2e/web-search-image-view.e2e.ts`
- Create: `apps/platform/e2e/anvia-v1-migration.e2e.ts`
- Create: `docs/superpowers/reports/anvia-v1-browser-qa.md`
- Evidence: `.playwright-mcp/anvia-v1/` (follow repository ignore/evidence convention)

**Interfaces:**
- Consumes: live local stack, real authenticated browser, existing fixtures, configured real models.
- Produces: automated and hands-on evidence for preserved user behavior.

- [ ] **Step 1: Add migration-specific E2E tests before changing assertions**

Add cases for protocol reload resume, approval across worker restart, replay rejection, queue during streaming, and rich clarification. Run the new spec and capture RED caused by any incomplete browser wiring.

```bash
pnpm --filter platform e2e -- anvia-v1-migration.e2e.ts
```

- [ ] **Step 2: Run deterministic/local browser suite**

```bash
pnpm --filter platform e2e
```

Expected: authentication shell, messages, queue, approvals, attachments, session operations, and stub-compatible cases pass without protocol console errors.

- [ ] **Step 3: Run the real-LLM specs serially**

```bash
pnpm --filter platform exec playwright test --config playwright.real-llm.config.ts --workers=1
```

Required scenarios:

1. plain streamed chat, reasoning, stop, regenerate, resubmit;
2. reload while streaming and exact-once resume;
3. PDF/image/CSV/XLSX upload, OCR/retrieval, citations, DataTable/DataChart;
4. web approval allow once, session grant, reject;
5. image approval with edited count/aspect/model settings and generated-image rendering;
6. Deep Research direct and gated paths, one-level child activity, citations, rejection invariant;
7. multiple queued follow-ups while streaming, edit/reorder/FIFO steering/ack/fresh-run fallback;
8. clarification single choice, multiple choice, free text, optional skip;
9. interaction response after worker restart, expiry/replay/wrong-session denial;
10. session switch/delete isolation and no browser secret/server-only bundle leakage.

- [ ] **Step 4: Perform hands-on headed QA**

Use the repository's real-browser workflow against `http://localhost:3000`. Capture screenshot, page snapshot, relevant network/protocol header, and console log per scenario under `.playwright-mcp/anvia-v1/`. Visually verify progress cards, approval/clarification focus, queue controls, attachments, charts, citations, error recovery, and mobile-width composer behavior.

- [ ] **Step 5: Diagnose and fix, never rerun blindly**

For each failure: preserve trace/screenshot/log, identify earliest incorrect state, add the smallest failing automated regression, fix root cause, run focused test, then rerun only the failed E2E before the full suite.

- [ ] **Step 6: Commit tests and report**

```bash
git add apps/platform/e2e docs/superpowers/reports/anvia-v1-browser-qa.md
git commit -m "test(e2e): verify Anvia v1 product parity"
```

### Task 19: Perform the final fixing loop and release-readiness audit

**Files:**
- Modify only files implicated by failing tests/review findings
- Create: `docs/superpowers/reports/anvia-v1-final-verification.md`
- Modify: `README.md` if final run instructions/patch note changed

**Interfaces:**
- Consumes: complete branch diff and all prior evidence.
- Produces: green, review-ready branch with no untriaged migration defect.

- [ ] **Step 1: Run removed-API and import-boundary audit**

```bash
rg -n "AgentBuilder|ExtractorBuilder|createChatTransport|createEventStream|createPrismaMemoryStore|langfuse\.create|connectMcp|mcp\.http|additionalParams|completionApi" packages apps
rg -n "@anvia/(openai|mistral|qdrant|langfuse|mcp|memory-prisma|server)" apps/platform/src
node scripts/verify-anvia-v1-dependencies.mjs
```

Expected: first search only intentional migration docs/tests; second has no browser imports; dependency guard passes.

- [ ] **Step 2: Run the complete verification matrix from a clean state**

```bash
pnpm install --frozen-lockfile
pnpm --filter @assingment/agent test
pnpm --filter @assingment/agent exec tsc --noEmit
pnpm --filter api test
pnpm --filter api build
pnpm --filter platform test
pnpm --filter platform exec tsc --noEmit
pnpm --filter platform build
pnpm --filter platform e2e
pnpm --filter platform exec playwright test --config playwright.real-llm.config.ts --workers=1
pnpm --filter api exec prisma validate
git diff --check
git status --short
```

Record fresh command output/counts. A prior passing run is not evidence for this step.

- [ ] **Step 3: Audit data and rollback safety**

Confirm no unplanned Prisma migration/seed change, existing sessions still load, new messages append, compaction works, and rollback to the pre-migration application does not require data reversal. If any migration exists, prove it is additive/backward compatible and document rollback.

- [ ] **Step 4: Request independent code review**

Invoke `superpowers:requesting-code-review`. Reviewer must inspect design/spec traceability, package graph, interaction durability/security, custom clarification boundary, protocol adapter, resource disposal, memory/data safety, patch maintenance, and browser evidence. Convert every accepted finding into a RED regression before fixing.

- [ ] **Step 5: Re-run impacted and full verification after fixes**

First run the narrow test that reproduced each finding. After all are green, rerun the complete matrix in Step 2. Do not claim completion if any check is skipped without an explicit external blocker and risk assessment.

- [ ] **Step 6: Write final verification report and commit**

Report target commit/package versions, branch, commits, test counts, browser scenarios/evidence paths, schema decision, resource lifecycle result, accepted residual risks, and rollback point.

```bash
git add docs/superpowers/reports/anvia-v1-final-verification.md README.md
git commit -m "docs: record Anvia v1 final verification"
git status --short
```

Expected: clean worktree.

- [ ] **Step 7: Prepare merge options but do not merge without the normal handoff**

Invoke `superpowers:finishing-a-development-branch` and present the verified merge/PR/keep/discard options. The implementation session may push or open a PR only when authorized by the user's normal delivery request. Do not deploy from this planning task.

## Completion Definition

The migration is complete only when:

- `feat/anvia-v1-migration` contains a synchronized exact Anvia 1.0.0 graph;
- no runtime uses a removed v0 API or mixed-major protocol;
- native approvals suspend without holding a worker and resume exactly once across restart;
- custom rich clarification behavior is intact and separately tested;
- queue steering, stop, retry, memory, compaction, citations, retrieval, Data Analysis, image generation, and Deep Research retain parity;
- API emits only valid `anvia.client.v3` framed streams with authorized resume;
- provider/Qdrant/MCP/Langfuse resources validate and close correctly;
- no unnecessary/destructive data migration was introduced;
- unit, typecheck, build, integration, automated browser, and hands-on real-browser checks pass on fresh runs;
- final independent review findings are fixed and reverified;
- the worktree is clean and the branch is ready for the user's chosen integration path.

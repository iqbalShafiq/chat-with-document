# Web Search (Tavily) + Context7 MCP with Approvals — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give the agent web search/fetch (Tavily) behind a per-session toggle + dynamic user approvals, plus optional context7 MCP docs, and surface web sources in the right rail.

**Architecture:** Web tools (`web_search`/`web_fetch`) live in `packages/agent/src/tools/web-search.ts` with an Anvia `approval` policy gated by a per-session toggle. The worker registers an `AgentBuilder.approvals` handler (Redis-backed approval registry) so a disabled toggle suspends the run and asks the user via stream events; `POST /api/chat/approvals/:id/decision` resolves it. Context7 connects via `@anvia/core`'s native MCP client (cached singleton, degrades to null). The platform shows an icon-only globe toggle in the composer, a glass approval card (headless `@anvia/react-ui` HumanInput), and a Web sources rail section.

**Tech Stack:** pnpm monorepo · @anvia/core 0.16 (createTool approval, AgentBuilder.approvals, mcp.http) · @tavily/core 0.7.6 · BullMQ + ioredis · React 19 + Tailwind 4 · Vitest 4 · zod 4

**Design doc:** `docs/superpowers/specs/2026-08-07-web-search-approvals-design.md`

**Branch:** `feat/web-search-tools`

**Verification commands (repo has NO lint scripts):**
- Agent: `pnpm --filter @assingment/agent exec tsc --noEmit`
- API: `pnpm --filter api exec tsc --noEmit` · tests `pnpm --filter api test` · build `pnpm --filter api build`
- Platform: `pnpm --filter platform exec tsc --noEmit` · build `pnpm --filter platform build`

---

## Tasks already completed (verify, then commit as one logical commit)

### Task 0: Agent tools + API wiring (DONE, uncommitted)

**Files:**
- Create: `packages/agent/src/tools/web-search.ts` — `createWebSearchTools` (web_search + web_fetch, approval policy with dynamic `reason` from args, bounded output, `mapTavilyError`, `createTavilyClient`, `WEB_SEARCH_INSTRUCTION`)
- Create: `packages/agent/src/tools/context7.ts` — `createContext7McpServer` via `connectMcp(mcp.http(...))`, `DEFAULT_CONTEXT7_URL`, `CONTEXT7_INSTRUCTION`
- Modify: `packages/agent/src/agent.ts` — `createAgent` options `approvals` + `mcpServers`
- Modify: `packages/agent/src/index.ts` — export new tools
- Create: `apps/api/src/modules/chat/approval-registry.ts` — `createApprovalRegistry(redis)` (handler emits `tool_approval_request`, polls decision key, timeout 5 min → `timed_out`; `publishDecision`, `getApproval`, `removeApproval`, `getApprovalRegistry` singleton)
- Create: `apps/api/src/lib/context7-server.ts` — cached `getContext7McpServer()` + `isContext7Configured()`
- Modify: `apps/api/src/modules/chat/build-run-input.ts` — `webSearchConfig()`, `webSearchEnabled`, `approvals`, `context7Server` inputs; web tools only when `TAVILY_API_KEY`; `webSearchAvailable`/`context7Available` in output
- Modify: `apps/api/src/modules/chat/run-queue.ts` — `webSearchEnabled` in `ChatRunJobData`
- Modify: `apps/api/src/modules/chat/run-worker.ts` — approval handler + `webSearchEnabled` + `getContext7McpServer()` in `buildChatRunInput`
- Modify: `apps/api/src/modules/chat/router.ts` — body `webSearchEnabled`, `GET /capabilities`, `POST /approvals/:approvalId/decision`

**Step 1: Typecheck** — Run: `pnpm --filter @assingment/agent exec tsc --noEmit && pnpm --filter api exec tsc --noEmit` — Expected: clean.

**Step 2: Commit**
```bash
git add packages/agent/src apps/api/src
git commit -m "feat(agent,api): tavily web tools with approvals + context7 mcp"
```

### Task 1: Platform tool presentation (DONE, uncommitted)

**Files:**
- Create: `apps/platform/src/lib/chat/web-sources.ts` — `collectWebSources(messages)` from completed web tool parts (dedupe by URL)
- Create: `apps/platform/src/components/composer/web-search-toggle.tsx` — icon-only glass globe pill (aria-switch, disabled when unavailable)
- Create: `apps/platform/src/components/chat/approval-panel.tsx` — glass card via `HumanInput` primitives + `toolActivityLabelForName`
- Modify: `apps/platform/src/components/composer/chat-composer.tsx` — toggle next to `ModelReasoningSwitcher`
- Modify: `apps/platform/src/components/tool-activity-panel.tsx` — labels + `toolActivityLabelForName`
- Modify: `apps/platform/src/components/tool-io-format.ts` — web_search/web_fetch formatters
- Modify: `apps/platform/src/components/chat/session-documents-panel.tsx` — `webSources` prop, section, open condition

**Step 1: Typecheck** — Run: `pnpm --filter platform exec tsc --noEmit` — Expected: clean.

**Step 2: Commit** — `git commit -am "feat(platform): web search toggle, approval card, web sources rail"`

---

## Remaining tasks

### Task 2: Platform wiring — routes/index.tsx + lib/api.ts

**Files:**
- Modify: `apps/platform/src/lib/api.ts` — add `WebCapabilities` type + `fetchChatCapabilities()` (GET `/api/chat/capabilities`, apiFetch pattern)
- Modify: `apps/platform/src/routes/index.tsx` — ChatSession: `webSearchEnabled` state (default false) + `webSearchEnabledRef`; `capabilities` state + fetch on mount (webSearchAvailable/context7Available); `useChat({ ..., humanInput: { endpoint: `${API_BASE}/api/chat` } })`; `createRequest` body adds `webSearchEnabled: webSearchEnabledRef.current`; render `<ApprovalPanel />` above composer dock (inside the dock container, before ChatComposer); pass toggle props into ChatComposer; `webSources = useMemo(() => collectWebSources(chat.messages), [chat.messages])`; pass `webSources` to SessionDocumentsRail.

**Step 1: Implement** the above (follow existing ref patterns: `selectedModelRef`).

**Step 2: Typecheck** — Run: `pnpm --filter platform exec tsc --noEmit` — Expected: clean.

**Step 3: Commit** — `git commit -am "feat(platform): wire web search state, human input, capabilities"`

### Task 3: Tests — agent web-search tools

**Files:**
- Create: `packages/agent/src/tools/web-search.test.ts`
- Modify: `packages/agent/package.json` — add `vitest` devDependency + `"test": "vitest run"` script

**Step 1: Write failing tests** (mock TavilyClient with vi.fn):
- approval policy `when()` is `!enabled` (true when disabled, false when enabled)
- `reason(ctx)` returns `ctx.args.reason`
- `web_search` output normalization: bounded to max 5 results, content truncated
- `web_search` maps Tavily 429 → "rate limit" message, network error → bounded message

**Step 2: Run** — `pnpm --filter @assingment/agent test` — Expected: tests pass (implementation exists).

**Step 3: Commit** — `git add packages/agent && git commit -m "test(agent): web search tool tests"`

### Task 4: Tests — API approval registry

**Files:**
- Create: `apps/api/src/modules/chat/approval-registry.test.ts`

**Step 1: Write failing tests** (in-memory fake `ApprovalRedis`; existing vitest pattern):
- handler stores record + appends `tool_approval_request`, returns approved after `publishDecision`
- rejected decision returns `{ approved: false, reason }` and appends `tool_approval_result`
- timeout path (small `timeoutMs`) returns not-approved + emits `timed_out` result
- `getApproval` round-trips a stored record; `removeApproval` deletes keys

**Step 2: Run** — `pnpm --filter api test` — Expected: all pass (implementation exists).

**Step 3: Commit** — `git commit -am "test(api): approval registry tests"`

### Task 5: Env + README

**Files:**
- Modify: `.env.example` — add `TAVILY_API_KEY=`, `CONTEXT7_API_KEY=`, `CONTEXT7_URL=https://mcp.context7.com/mcp`
- Modify: `README.md` — env table rows, agent tools table rows (web_search/web_fetch/context7), feature note (toggle + approvals + web sources rail)

**Step 1: Edit** both files per repo conventions.

**Step 2: Commit** — `git commit -am "docs: web search env vars and README"`

### Task 6: Full verification

**Step 1: Run all checks**
```bash
pnpm --filter @assingment/agent exec tsc --noEmit
pnpm --filter api exec tsc --noEmit
pnpm --filter api test
pnpm --filter api build
pnpm --filter platform exec tsc --noEmit
pnpm --filter platform build
```
Expected: all clean/passing.

**Step 2: Fix** any issues, re-run, commit fixes.

### Task 7: Manual smoke (requires user's TAVILY_API_KEY)

- Set `TAVILY_API_KEY` in `.env`; restart API + worker.
- Toggle off → ask a current-events question → agent should request approval (card appears with reason) → Allow → answer cites sources; Reject → agent answers without web.
- Toggle on → same question runs without approval.
- Web sources appear in right rail; context7 tools appear for library questions (when `CONTEXT7_API_KEY` set).

# Web Search (Tavily) + Context7 MCP with Dynamic Approvals — Design

Date: 2026-08-07
Branch: `feat/web-search-tools`

## 1. Goal

1. Give the agent (global + project chats) web capabilities: **web search** and **web fetch** backed by Tavily (`@tavily/core` is already a dependency, unused).
2. A per-session **web search toggle** (globe icon pill in the composer dock, no label) — default **off** for every new session.
3. When the toggle is off and the agent judges it needs web info, it calls the tool anyway; the run **suspends** and asks the **user for approval** with a reason generated **dynamically by the agent** (from the tool-call args). When the toggle is on, tools run immediately without approval.
4. Optional **Context7 MCP** integration so the agent can fetch up-to-date library/API documentation (semantic path via `@anvia/core`'s native MCP client).
5. Show **web sources** obtained during a run in the right sidebar (doc rail), alongside Active/Cited documents.

## 2. Research summary

- **Tavily** (`@tavily/core@0.7.6`, already in `packages/agent`): `tavily({ apiKey })` → `client.search(query, { searchDepth, maxResults, topic, includeAnswer, timeRange })` and `client.extract(urls)` (parsed page content). Credits-based; free tier exists. Covers both search and fetch semantics.
- **Context7** (upstash/context7): official MCP server at `https://mcp.context7.com/mcp` (streamable HTTP), optional `Authorization: Bearer <key>` (free key at context7.com/dashboard for higher rate limits). MCP tools: `resolve-library-id(query, libraryName)`, `query-docs(libraryId, query)`. Also has REST API + TS SDK, but MCP is the canonical integration.
- **Anvia v0.16.0 native approvals** (verified in installed types): `createTool({ approval: { when(ctx), reason(ctx), rejectMessage(ctx) } })` — `ctx.args` is zod-parsed automatically (`parseApprovalArgs`), so `reason` can be a **function of the actual tool args** (dynamic justification from the agent). `AgentBuilder.approvals({ handler(request) })` suspends the run until the handler returns a `ToolApprovalDecision`. No handler configured → `ToolApprovalRequiredError` → failed run (must avoid).
- **Anvia client contract** (`@anvia/react`): `useChat({ humanInput: { endpoint } })`; `defaultEventToApproval` maps stream events `{ type: "tool_approval_request", approval }` (and `tool_approval_result`) into `chat.humanInput.approvals`. `approveTool(id, reason?)` / `rejectTool(id, reason?)` POST to `{endpoint}/approvals/{approvalId}/decision` with `{ approved, reason? }` (deciding state tracked via `decidingApprovals`).
- **Anvia MCP support**: `mcp.http({ name, url, transport? })` → `connectMcp(conn)` → `McpServer { name, tools, close() }` → `AgentBuilder.mcp([server])`. Unused in app today. MCP tools cannot carry our custom approval policies.
- **`@anvia/react-ui` HumanInput is headless**: all components (`Panel`, `Approvals`, `Approval`, `Approve`, `Reject`, `ApprovalReason`, …) render plain divs/buttons/textareas with `data-anvia-*` attrs and accept standard HTML props — fully stylable. `Approve`/`Reject` auto-call `chat.approveTool/rejectTool` via `ChatProvider` context (needs `<ChatProvider controller={chat}>` wrapper) and manage disabled/deciding state. Semantic components + our glass styling.
- **Existing app**: no approval mechanism anywhere; single tool-wiring point `apps/api/src/modules/chat/build-run-input.ts` (used by both global and project chats); tools follow factory-with-deps pattern in `packages/agent/src/tools/*`; UI preferences follow `ModelReasoningSwitcher` (composer dock) + `chat-preferences.ts` (localStorage) patterns; right rail = `SessionDocumentsPanel` (`useHasSessionDocuments` drives open/close, desktop only).

## 3. Decisions (user-confirmed)

| Topic | Decision |
|---|---|
| Web backend | Tavily `search` + `extract` as two tools: `web_search` and `web_fetch` |
| Context7 integration | **MCP via `@anvia/core`** (`mcp.http` + `connectMcp` + `AgentBuilder.mcp`) — semantic SDK path, cached singleton server in the worker, graceful degrade when unreachable, env-gated |
| Approval mechanism | Anvia `approval` policy per tool (`when: () => !enabled`) + `AgentBuilder.approvals({ handler })`; `reason` derived from agent-provided `reason` arg (dynamic) |
| Approval wait | Redis-backed pending-approval registry; decision route writes a decision key, worker polls it (500ms) — chosen over pub/sub for zero extra connections and testability; timeout 5 min → auto-reject (`timed_out`); worker restart → run fails (existing `failChatRun` path) |
| Toggle | Globe icon pill, no label, in composer dock next to Model/Reasoning switcher; per-session state, default off; disabled + tooltip when `TAVILY_API_KEY` unset |
| Toggle transport | `webSearchEnabled: boolean` in `POST /api/chat` body → job payload → `buildChatRunInput` (same pattern as model/effort) |
| Approval UI | `@anvia/react-ui` `HumanInput` primitives wrapped in `<ChatProvider controller={chat}>`, styled as a glass card pinned above the composer |
| Web sources rail | New "Web sources" section in the right rail derived client-side from tool parts of `web_search`/`web_fetch` (same pattern as cited documents); rail opens when web sources exist; rows open the URL in a new tab |
| Tool availability | Web tools registered only when `TAVILY_API_KEY` is set; `GET /api/chat/capabilities` → `{ webSearchAvailable, context7Available }` |
| Context7 gating | Always available to the agent when `CONTEXT7_API_KEY` configured (optional; no toggle — doc lookups are low-cost and benign). Agent instructions choose context7 for library/API docs vs tavily for general web info |
| Error mapping | Bounded, non-sensitive tool errors ("Web search rate limit exceeded" etc.); never expose API keys or internal infra |

## 4. Agent tools (`packages/agent`)

### `src/tools/web-search.ts`

```ts
createWebSearchTools(input: {
  tavilyClient: TavilyClient;
  enabled: boolean;            // per-session toggle
  maxResults?: number;         // default 5, cap 5
  contentLimitChars?: number;  // default 400
}): AnyTool[]
```

- `web_search` — input `{ query: string, reason: string, maxResults?: 1..5, timeRange?: "day"|"week"|"month"|"year" }`; description tells the model when to use it and that `reason` is required.
- `web_fetch` — input `{ url: string (http/https), reason: string }`; uses `client.extract([url])`.
- Both tools carry:
  ```ts
  approval: {
    when: () => !input.enabled,
    reason: (ctx) => ctx.args.reason,        // dynamic agent reason
    rejectMessage: "Web search was declined. Answer from available knowledge.",
  }
  ```
- Output: normalized bounded result `{ results: [{ title, url, content, publishedDate?, score? }], query, answer? }` — content truncated to `contentLimitChars`.
- Execution: zod-validated args (auto), call Tavily, map failures to bounded messages (`401 → "web search is not configured"`, `429 → "web search rate limit exceeded"`, network → "web search temporarily unavailable").
- Export `WEB_SEARCH_INSTRUCTION` (when to use each tool; prefer context7 for library/API docs).

### `src/tools/context7.ts`

```ts
createContext7McpServer(input: { apiKey?: string; url?: string }): Promise<McpServer | null>
```

- `connectMcp(mcp.http({ name: "context7", url, transport: { headers: { authorization: `Bearer ${apiKey}` } } }))` when `apiKey` present, else without headers.
- Returns `null` on any connect error (logged by caller) — degrade gracefully.
- Export `CONTEXT7_INSTRUCTION` (use `resolve-library-id` + `query-docs` for library/API documentation questions).

### `src/agent.ts`

Extend `createAgent` options with:
- `approvals?: ToolApprovalsOptions` → `.approvals(approvals)`
- `mcpServers?: McpServer[]` → `.mcp(mcpServers)`

## 5. API (`apps/api`)

### `src/modules/chat/approval-registry.ts`

```ts
createApprovalHandler(input: {
  streamId: string; userId: string; sessionId: string;
  timeoutMs?: number;          // default 5 * 60_000
  append: (event: unknown) => Promise<void>;  // stream store append
  redis?: RedisLike;           // injectable for tests
}): (request: ToolApprovalRequest) => Promise<ToolApprovalDecision>
```

Flow per request:
1. `approvalId = randomUUID()`; HSET `chat-approval:{id}` `{ userId, sessionId, streamId, toolName, args, reason, status: "pending" }` EX 900.
2. Append `{ type: "tool_approval_request", approval: { id, runId, agentId, sessionId, toolName, callId, args: rawArgs, status: "pending", requestedAt, reason } }` to the stream.
3. `await waitForDecision(approvalId, timeoutMs)` — subscribes to channel `chat-approval:decision:{id}` via a shared pub/sub subscriber connection (module-level ioredis `duplicate()` + in-process EventEmitter registry); rejects on timeout.
4. On decision: HSET status, append `{ type: "tool_approval_result", approval: { ...status: approved|rejected, resolvedAt, reason } }`, return `{ approved }` or `{ approved: false, reason: rejectMessage ?? decisionReason }`.
5. On timeout: append result with status `timed_out`, return `{ approved: false, reason: "timed out" }`.

### Router (`src/modules/chat/router.ts`)

- `POST /api/chat` body gains `webSearchEnabled?: boolean` (default false) → included in `enqueueChatRun` job payload.
- `POST /api/chat/approvals/:approvalId/decision` `{ approved, reason? }` — `requireUser`; load `chat-approval:{id}`; 404 when missing; 403 when `userId` mismatch; publish `{ approved, reason, decisionAt }` to `chat-approval:decision:{id}`; expire hash; return `{ ok: true }`.
- `GET /api/chat/capabilities` → `{ webSearchAvailable: boolean, context7Available: boolean }` (env-driven).

### `src/modules/chat/run-queue.ts` / `run-worker.ts`

- Job payload + `ChatRunJobData` gain `webSearchEnabled: boolean`.
- Worker builds the approval handler (`createApprovalHandler({ streamId, append: (e) => store.append({ streamId, event: e }) })`) and passes it into `buildChatRunInput`.

### `src/modules/chat/build-run-input.ts`

- New inputs: `webSearchEnabled?: boolean`, `approvalHandler?: ToolApprovalsOptions`, `mcpServer?: McpServer | null`.
- Web tools registered only when `TAVILY_API_KEY` set (client from `tavily({ apiKey })` — keys live server-side only).
- `.approvals(...)` set only when web tools registered.
- Context7 server resolved via cached singleton `getContext7McpServer()` (module-level promise cache, null on failure).
- `WEB_SEARCH_INSTRUCTION` / `CONTEXT7_INSTRUCTION` added to instructions when respective tools are active.

### Env (`.env.example` + README)

- `TAVILY_API_KEY=` — required for web tools; absent → tools off, toggle disabled in UI.
- `CONTEXT7_API_KEY=` — optional (free key at https://context7.com/dashboard), higher rate limits.
- `CONTEXT7_URL=https://mcp.context7.com/mcp` — overridable.

## 6. Platform (`apps/platform`)

### Web search toggle

- `components/composer/web-search-toggle.tsx` — globe icon-only glass pill (same shell pattern as `ModelReasoningSwitcher`), `aria-pressed`, title tooltip ("Web search on/off" / "Web search not configured" when unavailable), accent when on, disabled during streaming.
- State lives in `ChatSession` (per-session, default `false`; a new session mounts fresh → default off); sent in `createRequest` body via a ref (matches `selectedModelRef` pattern).

### Approval UI

- Wrap the chat content area with `<ChatProvider controller={chat}>` (renders nothing).
- `components/chat/approval-panel.tsx` — pinned above the composer dock, renders only while `chat.humanInput.approvals.pending.length > 0`:
  - `HumanInput.Panel` + `HumanInput.Approvals` → per approval: `HumanInput.Approval` glass card showing tool label, the query/url, the agent's reason, `HumanInput.Approve` / `HumanInput.Reject` glass buttons (accent / danger), disabled + "Deciding…" while `chat.decidingApprovals` contains the id.
- `useChat({ humanInput: { endpoint: `${API_BASE}/api/chat` } })` — default `eventToApproval`/`decideApproval` already match our events and route.

### Web sources rail

- `lib/chat/web-sources.ts`: `collectWebSources(messages: UIMessage[]): WebSourceSummary[]` — walk `tool` parts whose `toolName` is `web_search`/`web_fetch` and state `output-available`, map `output.results` → `{ url, title, content, source }`, dedupe by URL (first wins). Same memo pattern as `cited-documents.ts`.
- `session-documents-panel.tsx`: new `webSources` prop; "Web sources" `CollapsibleDocumentSection` (globe leading icon, title link → opens URL in new tab `rel="noopener"`, domain meta, snippet); header subtitle includes web source count; `useHasSessionDocuments` also opens the rail when `webSources.length > 0`.

### Tool presentation

- `tool-activity-panel.tsx` `TOOL_LABELS`: `web_search: "Searching the web"`, `web_fetch: "Fetching web page"`, `resolve-library-id: "Looking up library"`, `query-docs: "Reading library docs"`.
- `tool-io-format.ts`: compact formatters for `web_search` (query + result count) and `web_fetch` (url); context7 tools fall back to generic.

## 7. Error handling / edge cases

- `TAVILY_API_KEY` unset → tools never registered → model cannot call them; toggle disabled in UI.
- Approval never answered → 5 min timeout → auto-reject with `timed_out`; agent continues without web data.
- Worker crash mid-approval → a process crash (vs an in-process handler failure) leaves the stream running until TTL, same as any pre-existing run crash; in-process failures (e.g. an append error) do hit `failChatRun` (stream error + failed pair + lock release).
- Context7 down → `connectMcp` fails → logged, agent runs without it.
- Stop pressed during approval wait → stop flag only checked between stream events; run continues until approval/timeout (accepted for v1, capped by timeout).
- Rejoin/resume during pending approval → stream replay re-delivers `tool_approval_request` → client re-renders the card (idempotent decision route).

## 8. Testing

- `packages/agent` (add vitest devDep): `web-search.test.ts` — approval policy on/off, dynamic reason from args, output normalization (bounded, dedupe), error mapping with mocked `TavilyClient` (vi.fn).
- `apps/api`: `approval-registry.test.ts` — request → event appended → decision resolves → result event; timeout path; ownership mismatch (403-equivalent logic) — injectable fake Redis (existing vitest pattern, pure helpers).
- Manual E2E (needs `TAVILY_API_KEY` from https://app.tavily.com — free tier): toggle on → search without approval; toggle off → approval card → approve → search runs; reject → agent answers without web; context7 docs query.

## 9. Verification

- `pnpm --filter api typecheck`, `pnpm --filter platform typecheck`, `pnpm --filter agent typecheck` (or workspace equivalents); `pnpm --filter api lint`, platform lint; `pnpm --filter api test` (+ agent tests); `pnpm build` for all affected workspaces.

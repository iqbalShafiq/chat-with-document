# Sidebar Session Status (Running Progress + Unread) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a progress bar on sidebar sessions whose chat worker is currently running (selected or not), and an unread marker on sessions whose run completed while the user was not viewing them — cleared when the session is opened.

**Architecture:** Add `ChatSession.lastReadAt` (migration) so "unread" is computed server-side as "a completed run exists after `lastReadAt`". A lightweight `GET /api/chat/runs` endpoint (Redis scan of `rs-active:*` + stream meta, scoped to the user) tells the sidebar which sessions are mid-run. The frontend polls both on a 10s interval, marks sessions read on open / stream settle, and renders an indeterminate animated bar + an accent unread dot.

**Tech Stack:** Prisma/Postgres, Hono, Redis (ioredis), React 19, Tailwind v4.

## Global Constraints

- Branch: `feat/context-window-compaction` (continue on it).
- Do not change how runs are executed; this feature only ADDS read-side endpoints and UI.
- "Unread" counts only `AgentUsageEvent.status = "completed"` runs (failed runs are not unread).
- The currently-open session must NEVER show the unread marker (client-side skip by `activeSessionId`).
- Poll interval 10s; keep the poll cheap (one Redis scan + one grouped usage query, not per-session subqueries).
- `markSessionRead` is idempotent; call it on session open AND when a run settles while that session is active (so a reply the user watched does not become unread later).
- TypeScript strict + `verbatimModuleSyntax` + ESM `.js` extensions in apps/api; `#/` import alias in apps/platform.
- Verification: `pnpm --filter api exec tsc --noEmit` (or `apps/api/node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit`), `pnpm --filter api test`, platform tsc + `pnpm --filter platform build`.

---

### Task 1: Migration + server unread computation + mark-read endpoint

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (ChatSession model)
- Create: `apps/api/prisma/migrations/<auto>_add_chat_session_last_read_at/migration.sql` (via `prisma migrate dev`)
- Modify: `apps/api/src/modules/chat/session-list.ts`
- Modify: `apps/api/src/modules/chat/router.ts` (add `POST /sessions/mark-read`)

**Interfaces:**
- Consumes: existing `prisma`, `requireUser`, `AuthVariables`, `requireSessionId`.
- Produces:
  - `SessionListItem` gains `unread: boolean`.
  - `export async function markChatSessionRead(input: { userId: string; sessionId: string }): Promise<void>` (in `session-list.ts`) — sets `lastReadAt = new Date()`, no-op when the row does not exist.

- [ ] **Step 1: Add `lastReadAt` to the schema**

In `apps/api/prisma/schema.prisma`, ChatSession model, after `updatedAt`:

```prisma
  /// When the user last opened/read this session (clears the sidebar unread marker).
  lastReadAt DateTime?
```

- [ ] **Step 2: Run the migration**

Run: `pnpm --filter api db:migrate -- --name add_chat_session_last_read_at`
Expected: migration created and applied; Prisma client regenerated. Verify the client has `lastReadAt` (`pnpm --filter api exec tsc --noEmit`).

- [ ] **Step 3: Extend `session-list.ts`**

Add `unread: boolean` to `SessionListItem`. In `listSessionsPage`:
- Add `lastReadAt: true` to the `select` of the `chatSession.findMany`.
- After `titles` is resolved, run ONE grouped query scoped to the page's sessions:

```ts
const pageIds = page.map((row) => row.id);
const completedRuns = await prisma.agentUsageEvent.groupBy({
  by: ["sessionId"],
  where: {
    userId: input.userId,
    sessionId: { in: pageIds },
    status: "completed",
  },
  _max: { createdAt: true },
});
const lastCompletedBySession = new Map(
  completedRuns.map((row) => [row.sessionId, row._max.createdAt]),
);
```

Map items with:

```ts
const items: SessionListItem[] = page.map((row) => {
  const lastCompleted = lastCompletedBySession.get(row.id) ?? null;
  const unread =
    lastCompleted !== null &&
    (row.lastReadAt === null || lastCompleted > row.lastReadAt);
  return {
    sessionId: row.id,
    updatedAt: row.updatedAt.toISOString(),
    title: titles.get(row.id) ?? row.title ?? "New chat",
    projectId: row.projectId,
    unread,
  };
});
```

Add at the end of the file:

```ts
export async function markChatSessionRead(input: {
  userId: string;
  sessionId: string;
}): Promise<void> {
  await prisma.chatSession.updateMany({
    where: { id: input.sessionId, userId: input.userId },
    data: { lastReadAt: new Date() },
  });
}
```

- [ ] **Step 4: Add the route to `apps/api/src/modules/chat/router.ts`**

Import `markChatSessionRead` from `./session-list.js`. Add BEFORE `.post("/truncate", ...)`:

```ts
.post("/sessions/mark-read", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const sessionId = requireSessionId(body?.sessionId);
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
  await markChatSessionRead({ userId: user.id, sessionId });
  return c.json({ ok: true });
})
```

- [ ] **Step 5: Verify**

Run: `pnpm --filter api exec tsc --noEmit` (exit 0) and `pnpm --filter api test` (all pass, unchanged suite). Quick runtime check: `pnpm --filter api with-env tsx -e "..."` is not needed — Task 5 smoke covers it.

- [ ] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations apps/api/src/modules/chat/session-list.ts apps/api/src/modules/chat/router.ts
git commit -m "feat(api): session unread marker + mark-read endpoint"
```

---

### Task 2: Active runs endpoint

**Files:**
- Modify: `apps/api/src/modules/chat/router.ts`

**Interfaces:**
- Consumes: `getRedis` from `../../lib/redis.js`, `getStreamStore` from `../../lib/resumable-stream-store.js`, `requireUser`.
- Produces: `GET /api/chat/runs` → `{ runs: Array<{ sessionId: string; streamId: string; status: string; lastEventId: number }> }` — only runs belonging to the authenticated user with stream status `running`.

- [ ] **Step 1: Implement the route**

Add to `apps/api/src/modules/chat/router.ts` (after the `/sessions/mark-read` route):

```ts
.get("/runs", async (c) => {
  const user = c.get("user");
  const redis = getRedis();
  const store = getStreamStore();

  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, found] = await redis.scan(
      cursor,
      "MATCH",
      "rs-active:*",
      "COUNT",
      200,
    );
    cursor = next;
    keys.push(...found);
  } while (cursor !== "0");

  const runs: Array<{
    sessionId: string;
    streamId: string;
    status: string;
    lastEventId: number;
  }> = [];
  for (const key of keys) {
    const sessionId = key.slice("rs-active:".length);
    if (!sessionId) continue;
    const streamId = await redis.get(key);
    if (!streamId) continue;
    const meta = await store.getMeta(streamId);
    if (!meta || meta.userId !== user.id) continue;
    const state = await store.status({ streamId });
    if (state.status !== "running") continue;
    runs.push({
      sessionId,
      streamId,
      status: state.status,
      lastEventId: state.lastEventId,
    });
  }
  return c.json({ runs });
})
```

Note: `getRedis()` returns an ioredis client; `redis.scan(cursor, "MATCH", pattern, "COUNT", n)` returns `[nextCursor, keys]` (tuple). If the tuple destructure types complain, use the object form `redis.scan(cursor, "MATCH", "rs-active:*", "COUNT", 200)` and read `.nextCursor` / `.keys` — verify against the installed ioredis types and adjust accordingly.

- [ ] **Step 2: Verify**

Run: `pnpm --filter api exec tsc --noEmit` → exit 0. Runtime: with Redis up (`docker compose up -d redis`), hit the endpoint without a session → 401 (auth guard); full runtime smoke in Task 5.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/chat/router.ts
git commit -m "feat(api): active chat runs endpoint for the sidebar"
```

---

### Task 3: Platform API client

**Files:**
- Modify: `apps/platform/src/lib/api.ts`

**Interfaces:**
- Consumes: `apiFetch`, `API_BASE` (existing).
- Produces:
  - `SessionListItem` gains `unread: boolean` (response parsing keeps `false` when missing).
  - `export type ActiveRunInfo = { sessionId: string; streamId: string; status: string; lastEventId: number }`
  - `export async function listActiveRuns(): Promise<ActiveRunInfo[]>` — GET `${API_BASE}/api/chat/runs`, parse `{ runs: [...] }`, throw `Error` on non-ok (401 handled by `apiFetch`).
  - `export async function markSessionRead(sessionId: string): Promise<void>` — POST `${API_BASE}/api/chat/sessions/mark-read` with `{ sessionId }`, throw on non-ok.

- [ ] **Step 1: Extend `SessionListItem` + `listSessions` parsing**

In `apps/platform/src/lib/api.ts`:

```ts
export type SessionListItem = {
  sessionId: string;
  updatedAt: string;
  title: string;
  projectId?: string | null;
  /** True when a completed run exists after the user last read this session. */
  unread: boolean;
};
```

In `listSessions` (the existing filter), include `unread`:

```ts
return {
  items: page.items.filter(
    (item): item is SessionListItem =>
      !!item &&
      typeof item.sessionId === "string" &&
      typeof item.updatedAt === "string" &&
      typeof item.title === "string",
  ).map((item) => ({
    ...item,
    unread: item.unread === true,
  })),
  nextCursor: ...unchanged...,
};
```

- [ ] **Step 2: Add `listActiveRuns` and `markSessionRead`**

```ts
export type ActiveRunInfo = {
  sessionId: string;
  streamId: string;
  status: string;
  lastEventId: number;
};

export async function listActiveRuns(): Promise<ActiveRunInfo[]> {
  const response = await apiFetch(`${API_BASE}/api/chat/runs`);
  if (!response.ok) throw new Error("Failed to load active runs");
  const data: unknown = await response.json();
  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Array.isArray((data as { runs?: unknown }).runs)
  ) {
    const runs = (data as { runs: unknown[] }).runs.filter(
      (run): run is ActiveRunInfo =>
        !!run &&
        typeof run === "object" &&
        typeof (run as ActiveRunInfo).sessionId === "string" &&
        typeof (run as ActiveRunInfo).streamId === "string",
    );
    return runs;
  }
  throw new Error("Unexpected active runs response shape");
}

export async function markSessionRead(sessionId: string): Promise<void> {
  const response = await apiFetch(
    `${API_BASE}/api/chat/sessions/mark-read`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    },
  );
  if (!response.ok) throw new Error("Failed to mark session read");
}
```

- [ ] **Step 3: Verify**

Run: `apps/platform/node_modules/.bin/tsc -p apps/platform/tsconfig.json --noEmit` → exit 0, and `pnpm --filter platform build` → PASS (chunk-size warning is pre-existing).

- [ ] **Step 4: Commit**

```bash
git add apps/platform/src/lib/api.ts
git commit -m "feat(platform): active runs + mark-read API client"
```

---

### Task 4: Sidebar UI — progress bar + unread dot

**Files:**
- Modify: `apps/platform/src/styles.css` (keyframes)
- Modify: `apps/platform/src/components/sidebar/session-history-list.tsx`
- Modify: `apps/platform/src/components/sidebar/chat-sidebar.tsx`
- Modify: `apps/platform/src/components/layout/app-shell.tsx`

**Interfaces:**
- Consumes: `SessionListItem.unread` (Task 1/3).
- Produces:
  - `SessionHistoryList` new prop `activeRuns: ReadonlySet<string>` (sessionIds whose worker is running).
  - `ChatSidebar` new prop `activeRuns: ReadonlySet<string>`, forwarded to `SessionHistoryList`.
  - `AppShell` new prop `activeRuns: ReadonlySet<string>`, forwarded to `ChatSidebar`.

- [ ] **Step 1: Add the progress keyframes to `styles.css`**

Append at the end of `apps/platform/src/styles.css`:

```css
/* Sidebar running-session progress bar (indeterminate sweep). */
@keyframes sidebar-progress {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(300%);
  }
}
```

- [ ] **Step 2: Update `SessionHistoryList`**

Add the prop:

```ts
export function SessionHistoryList({
  sessions,
  activeSessionId,
  activeRuns,
  ...
}: {
  sessions: SessionSummary[];
  activeSessionId: string;
  activeRuns: ReadonlySet<string>;
  ...
}) {
```

In the item button (inside `group.items.map`), compute and render:

```tsx
const selected = session.sessionId === activeSessionId;
const running = activeRuns.has(session.sessionId);
const unread = session.unread && !selected;
...
<button
  type="button"
  onClick={() => onSelect(session.sessionId)}
  title={session.title}
  aria-current={selected ? "page" : undefined}
  className={`relative flex w-full min-h-9 cursor-pointer items-center rounded-xl px-3.5 py-2.5 text-left text-[13px] leading-snug transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.99] ${
    selected
      ? "glass-pane font-medium text-text"
      : "text-text-muted hover:bg-white/[0.035] hover:text-text"
  }`}
>
  <span className="min-w-0 flex-1 truncate">{session.title}</span>
  {unread ? (
    <span
      className="ml-2 size-1.5 shrink-0 rounded-full bg-accent"
      aria-label="Unread messages"
      title="Unread"
    />
  ) : null}
  {running ? (
    <span
      className="absolute inset-x-3 bottom-[0.35rem] h-0.5 overflow-hidden rounded-full bg-white/[0.08]"
      aria-hidden
    >
      <span className="block h-full w-1/3 rounded-full bg-accent/80 animate-[sidebar-progress_1.2s_ease-in-out_infinite]" />
    </span>
  ) : null}
</button>
```

- [ ] **Step 3: Update `ChatSidebar`**

Add `activeRuns: ReadonlySet<string>` to the props type and pass it to `SessionHistoryList`:

```tsx
<SessionHistoryList
  sessions={sessions}
  activeRuns={activeRuns}
  ...
/>
```

- [ ] **Step 4: Update `AppShell`**

Add `activeRuns: ReadonlySet<string>` to the props type and pass it to `ChatSidebar`.

- [ ] **Step 5: Verify**

Run: `apps/platform/node_modules/.bin/tsc -p apps/platform/tsconfig.json --noEmit` → exit 0 and `pnpm --filter platform build` → PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/platform/src/styles.css apps/platform/src/components/sidebar/session-history-list.tsx apps/platform/src/components/sidebar/chat-sidebar.tsx apps/platform/src/components/layout/app-shell.tsx
git commit -m "feat(platform): sidebar running progress bar + unread dot"
```

---

### Task 5: index.tsx wiring — polling, mark read, props

**Files:**
- Modify: `apps/platform/src/routes/index.tsx`

**Interfaces:**
- Consumes: `listActiveRuns`, `markSessionRead` (Task 3), `activeRuns` prop chain (Task 4), `loadSessionsFirstPage` (existing).
- Produces: `Home` polls runs + refreshes the session list; marks the session read on open and on stream settle; passes `activeRuns` to `AppShell`.

- [ ] **Step 1: State + ref**

Add near the other session state (line ~188):

```ts
const [activeRuns, setActiveRuns] = useState<ReadonlySet<string>>(new Set());
const activeRunsRef = useRef<ReadonlySet<string>>(new Set());
activeRunsRef.current = activeRuns;
```

- [ ] **Step 2: Poll effect**

Add after `loadSessionsFirstPage` is defined (it must be in scope; place the effect after the `loadSessionsFirstPage` useCallback):

```ts
// Sidebar status: which sessions have a running worker, and refresh the list
// so unread markers appear once a run completes in the background.
useEffect(() => {
  let cancelled = false;
  const poll = async () => {
    try {
      const runs = await listActiveRuns();
      if (cancelled) return;
      const next = new Set(runs.map((run) => run.sessionId));
      const changed =
        next.size !== activeRunsRef.current.size ||
        [...next].some((id) => !activeRunsRef.current.has(id));
      setActiveRuns(next);
      if (changed) {
        await loadSessionsFirstPage();
      }
    } catch (error) {
      if (error instanceof ApiAuthError) {
        handleAuthFailure();
        return;
      }
      // Transient poll failure — keep the last known state.
    }
  };
  void poll();
  const timer = window.setInterval(() => {
    void poll();
  }, 10_000);
  return () => {
    cancelled = true;
    window.clearInterval(timer);
  };
}, [loadSessionsFirstPage, handleAuthFailure]);
```

- [ ] **Step 3: Mark read on session open**

Add a dedicated effect keyed on `sessionId` (place near the other `[sessionId]` effects):

```ts
// Opening a session clears its unread marker.
useEffect(() => {
  if (!sessionId) return;
  void markSessionRead(sessionId).catch(() => {});
}, [sessionId]);
```

- [ ] **Step 4: Mark read when a run settles while viewing**

In the `ChatSession` component (the one receiving `onStreamSettled`), locate `onStreamSettled`'s definition in `Home` and wrap it — or simpler: add the mark-read call inside `ChatSession`'s stream-settled effect. Find the effect that fires when `wasStreamingRef.current && chat.status !== "streaming"` (it already calls `onStreamSettled()` and `focusComposer()`); add right after `onStreamSettled()`:

```ts
void markSessionRead(sessionId).catch(() => {});
```

(`sessionId` is a prop of `ChatSession`; `markSessionRead` is imported in the file.)

- [ ] **Step 5: Pass `activeRuns` to `AppShell`**

In `Home`'s `<AppShell ...>` render (line ~682), add `activeRuns={activeRuns}` to the props.

- [ ] **Step 6: Verify**

Run: `apps/platform/node_modules/.bin/tsc -p apps/platform/tsconfig.json --noEmit` → exit 0, `pnpm --filter platform build` → PASS.

Smoke (start ONE fresh stack: `docker compose up -d db redis qdrant`, then `pnpm dev`):
1. Open a session, send a message → the sidebar row for that session shows the animated progress bar while streaming (both selected AND when switching to another session mid-run).
2. When the run completes while the session is NOT open → switch away before completion → after completion the row shows the accent unread dot; the dot disappears after opening the session (within one poll or immediately via the open effect).
3. When the run completes while the session IS open → no dot ever appears on that row, and after navigating away it stays clean (mark-read on settle covered it).
4. `GET /api/chat/runs` returns the running session only for the authenticated user; idle state returns `{ runs: [] }`.

- [ ] **Step 7: Commit**

```bash
git add apps/platform/src/routes/index.tsx
git commit -m "feat(platform): sidebar run polling + mark-read wiring"
```

---

## Self-Review Notes

- **Spec coverage:** running progress bar (Tasks 2+4+5), shown for selected AND unselected sessions (Task 4 render is independent of `selected`); unread marker for completed-and-unopened (Task 1 server computation + Task 5 mark-read-on-open); active session gets no marker (Task 4 `unread = session.unread && !selected` + Task 5 mark-read on settle); migration (Task 1). All design points mapped.
- **Placeholder scan:** every step carries concrete code; no TBD/TODO.
- **Type consistency:** `unread: boolean` flows `SessionListItem` (server `session-list.ts`) → client `api.ts` → `SessionSummary` (`session-history.ts` re-exports `SessionListItem`) → `SessionHistoryList`; `activeRuns: ReadonlySet<string>` flows `Home` → `AppShell` → `ChatSidebar` → `SessionHistoryList`; `markChatSessionRead`/`listActiveRuns`/`markSessionRead` names are consistent across tasks.

# Session Rename/Delete + Profile Provenance — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add rename & delete actions for chat sessions (sidebar overflow menu, dialogs, animations) with safe stop-then-delete of active runs, plus session provenance on personalization memory and LLM-based profile reconsideration when a session is deleted.

**Architecture:**
- **Backend (apps/api):** new `PATCH /api/chat/sessions/:id` (rename) and `DELETE /api/chat/sessions/:id?confirm=true` (delete). Delete stops any active run (stop flag + cancel pending approvals + poll for worker lock release, 409 fallback), captures a bounded message snapshot, hard-deletes rows (extending `deleteChatSessionsHard` with `sessionImageContext`), then best-effort enqueues a profile "reconsideration" for user scope (+ project scope when applicable).
- **Profile provenance (packages/agent + apps/api + apps/platform):** `explicitFacts` gain `source: { sessionId, messageId }`; `sections` bullets change from `string` to `{ text, sources: string[] }` (legacy rows normalized on read — no DB migration). The summarizer prompt tags delta messages with their sessionId and asks the LLM to attribute sources.
- **Reconsideration runs inside the existing profile worker/queue (no second worker, no double LLM call):** a Redis key holds pending `{ deletedSessionId, snapshot }` items; the next job for that scope consumes them and passes them as extra context/instruction to the same summarizer LLM call (runs even with an empty delta).
- **Frontend (apps/platform):** each sidebar history row gets a hover-revealed `MoreHorizontal` button; the menu opens via a portaled fixed-position popover to the right of the row (sidebar clips absolute positioning); rename uses `DialogShell` + `FormTextField`, delete uses `ConfirmDialog`; rows fade out before removal.

**Tech Stack:** Hono, Prisma (Postgres), BullMQ + Redis, @anvia/*, @assingment/agent, React 19, TanStack Router, Tailwind v4, lucide-react, vitest.

**Design doc:** `docs/plans/2026-08-12-session-rename-delete-profile-provenance-design.md`

---

## Known pitfalls (from design validation)

1. **Never value-import `@assingment/agent` in API modules that unit tests import** — its index constructs a Mistral client that throws "Missing Mistral credentials" at import time without env. Use `import type` (erased) and local helpers instead. `session-delete.ts` must import `extractTextFromMessageJson` from the local `session-list.ts` (export it) and `type ProfileScope` from the agent package.
2. The pure snapshot builder must live in its own env-free module (`session-snapshot.ts`) so it is unit-testable.
3. `buildChatRunInput` currently does NOT receive `promptMessage` — add it to the input type and pass it from `run-worker.ts`.
4. The snapshot char cap must include the `[iso] ` prefix length in the budget (a test catches this).
5. Agent tsconfig enables `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` — guard `sections[key]` with `?? []`, use conditional spreads for optional fields.
6. Router needs `ChatSessionNotFoundError` imported (it is NOT already imported).
7. Platform settings UI renders bullets — must use `.text`.
8. In shell pipelines, `head`/`tail` mask exit codes — check exit explicitly after each verification command.

## Verification commands

```bash
# API: unit tests + typecheck
pnpm --filter api test                          # 16 files, ~149 tests expected
pnpm --filter api build                         # tsc, must be silent

# Agent package: typecheck + tests
cd packages/agent && npx tsc --noEmit && npx vitest run

# Platform: tests + typecheck
cd apps/platform && pnpm test && npx tsc --noEmit
```

---

## Task 1: Backend — session title normalization + rename service

**Files:**
- Modify: `apps/api/src/modules/chat/chat-session.ts`
- Create: `apps/api/src/modules/chat/chat-session.test.ts`

**Step 1: Write the failing test**

`apps/api/src/modules/chat/chat-session.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeSessionTitle } from "./chat-session.js";

describe("normalizeSessionTitle", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeSessionTitle("  Hello   world \n ")).toBe("Hello world");
  });

  it("returns null for empty / whitespace-only input", () => {
    expect(normalizeSessionTitle("")).toBeNull();
    expect(normalizeSessionTitle("   ")).toBeNull();
  });

  it("caps length at 48 chars (TITLE_MAX parity)", () => {
    const long = "a".repeat(100);
    expect(normalizeSessionTitle(long)).toHaveLength(48);
  });
});
```

**Step 2:** `pnpm --filter api test src/modules/chat/chat-session.test.ts` → FAIL (no export).

**Step 3: Implement** — append to `chat-session.ts` (after `touchChatSession`):

```ts
/** Sidebar title normalization: trim, collapse whitespace, cap at 48 chars. */
export function normalizeSessionTitle(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.slice(0, 48);
}

/**
 * Rename a chat session (user-scoped). Throws ChatSessionNotFoundError when
 * the session does not exist for this user.
 */
export async function renameChatSession(input: {
  userId: string;
  sessionId: string;
  title: string;
}): Promise<ChatSessionRow> {
  const title = normalizeSessionTitle(input.title);
  if (!title) throw new Error("title is required");
  const existing = await prisma.chatSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
  });
  if (!existing) throw new ChatSessionNotFoundError();
  return prisma.chatSession.update({
    where: { id: existing.id },
    data: { title },
  });
}
```

**Step 4:** test PASS; `pnpm --filter api build` silent; verify exit codes explicitly (`echo "EXIT=$?"`).

**Step 5: Commit** `feat(api): session title normalization + rename service`

---

## Task 2: Backend — extend hard delete with session image contexts

**Files:**
- Modify: `apps/api/src/modules/chat/chat-session.ts` (`deleteChatSessionsHard`)

**Step 1:** inside the `$transaction`, before `agentUsageEvent.deleteMany`, add:

```ts
await tx.sessionImageContext.deleteMany({
  where: { userId, sessionId: { in: ids } },
});
```

**Step 2:** `pnpm --filter api build` silent.

**Step 3: Commit** `feat(api): clean session image contexts on hard delete`

---

## Task 3: Backend — env-free snapshot builder + tests

**Files:**
- Create: `apps/api/src/modules/chat/session-snapshot.ts`
- Create: `apps/api/src/modules/chat/session-delete.test.ts`

**Step 1: Write the failing test** (`session-delete.test.ts`):

```ts
import { describe, expect, it } from "vitest";
import { buildSessionSnapshotText } from "./session-snapshot.js";

describe("buildSessionSnapshotText", () => {
  it("keeps only the last 12 messages", () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
      text: `message ${i}`,
    }));
    const out = buildSessionSnapshotText(rows);
    expect(out).toContain("message 4");
    expect(out).not.toContain("message 0");
  });

  it("drops empty messages and caps total chars", () => {
    const out = buildSessionSnapshotText([
      { createdAt: new Date(), text: "   " },
      { createdAt: new Date(), text: "x".repeat(10_000) },
    ]);
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out).toMatch(/\[.*\] x+…/);
  });
});
```

**Step 2:** run → FAIL.

**Step 3: Implement** (`session-snapshot.ts`):

```ts
/** Bounded snapshot of the session's user messages (profile reconsideration input). */
export const SNAPSHOT_MAX_MESSAGES = 12;
export const SNAPSHOT_MAX_CHARS = 8000;

export function buildSessionSnapshotText(
  rows: Array<{ createdAt: Date; text: string }>,
): string {
  const parts: string[] = [];
  let used = 0;
  for (const row of rows.slice(-SNAPSHOT_MAX_MESSAGES)) {
    const text = row.text.trim();
    if (!text) continue;
    const prefix = `[${row.createdAt.toISOString()}] `;
    const budget = SNAPSHOT_MAX_CHARS - used - prefix.length;
    if (budget <= 0) break;
    const clipped = text.length > budget ? `${text.slice(0, budget - 1)}…` : text;
    parts.push(`${prefix}${clipped}`);
    used += prefix.length + clipped.length;
  }
  return parts.join("\n");
}
```

**Step 4:** PASS. **Commit** `feat(api): bounded session snapshot builder`

---

## Task 4: Backend — stop-then-delete service

**Files:**
- Modify: `apps/api/src/modules/chat/session-list.ts` (export `extractTextFromMessageJson`)
- Create: `apps/api/src/modules/chat/session-delete.ts`
- Note: Task 5 (queue) must exist before this compiles — implement Task 4 and Task 5 together, then verify.

**session-delete.ts:**

```ts
import type { ProfileScope } from "@assingment/agent";
import { getRedis } from "../../lib/redis.js";
import { getStreamStore } from "../../lib/resumable-stream-store.js";
import { prisma } from "../../utils/prisma.js";
import { enqueueProfileReconsideration } from "../profiling/queue.js";
import { profileConfig } from "../profiling/service.js";
import { getApprovalRegistry } from "./approval-registry.js";
import {
  deleteChatSessionsHard,
  getChatSession,
} from "./chat-session.js";
import { createDefaultMemoryScopeKey } from "./memory-scope.js";
import { ACTIVE_RUN_KEY } from "./run-queue.js";
import { extractTextFromMessageJson } from "./session-list.js";
import { buildSessionSnapshotText } from "./session-snapshot.js";

export class SessionRunActiveError extends Error {
  readonly code = "SESSION_RUN_ACTIVE";
  constructor(message = "Session is still processing; try again in a moment") {
    super(message);
    this.name = "SessionRunActiveError";
  }
}

const RUN_SETTLE_TIMEOUT_MS = 8000;
const RUN_SETTLE_POLL_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask the worker to end the run (stop flag + unblock human-input waiters),
 * then wait for the active-run lock to be released by the worker. Returns
 * true when a running stream was stopped. Throws SessionRunActiveError when
 * the run cannot settle within the timeout — delete must NOT race the
 * worker, because the memory store upserts its session row and could
 * resurrect the deleted session.
 */
export async function stopActiveRunForSession(
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const redis = getRedis();
  const store = getStreamStore();
  const streamId = await redis.get(ACTIVE_RUN_KEY(sessionId));
  if (!streamId) return false;

  const state = await store
    .status({ streamId })
    .catch(() => ({ status: "missing" as const, lastEventId: 0 }));
  if (state.status !== "running") {
    // Stale lock from a crashed run — drop it so the delete can proceed.
    await redis.del(ACTIVE_RUN_KEY(sessionId));
    return false;
  }

  await store.setStopFlag(streamId);
  await getApprovalRegistry()
    .cancelPendingForStream(streamId)
    .catch(() => ({ approvals: 0, clarifications: 0 }));

  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = await redis.get(ACTIVE_RUN_KEY(sessionId));
    if (!current) return true;
    await sleep(RUN_SETTLE_POLL_MS);
  }
  throw new SessionRunActiveError();
}

async function captureSessionSnapshot(
  userId: string,
  sessionId: string,
): Promise<string> {
  const scopeKey = createDefaultMemoryScopeKey(sessionId, userId);
  const memorySession = await prisma.agentMemorySession.findUnique({
    where: { scopeKey },
    select: { id: true },
  });
  if (!memorySession) return "";
  const rows = await prisma.agentMemoryMessage.findMany({
    where: { memorySessionId: memorySession.id, role: "user" },
    orderBy: [{ position: "asc" }, { id: "asc" }],
    select: { createdAt: true, message: true },
  });
  const texts: Array<{ createdAt: Date; text: string }> = [];
  for (const row of rows) {
    const text = extractTextFromMessageJson(row.message)?.trim() ?? "";
    if (text) texts.push({ createdAt: row.createdAt, text });
  }
  return buildSessionSnapshotText(texts);
}

/**
 * Delete a chat session for the user:
 * 1. ownership check (404),
 * 2. stop an active run if any (stop flag → poll lock release; 409 on timeout),
 * 3. capture a bounded message snapshot (before rows vanish),
 * 4. hard delete,
 * 5. best-effort enqueue profile reconsideration (user + project scopes).
 */
export async function deleteChatSession(
  userId: string,
  sessionId: string,
): Promise<{ deleted: true; hadActiveRun: boolean }> {
  const chatSession = await getChatSession(userId, sessionId);
  const hadActiveRun = await stopActiveRunForSession(userId, sessionId);

  const reconsiderEnabled = profileConfig().enabled;
  const snapshot = reconsiderEnabled
    ? await captureSessionSnapshot(userId, sessionId)
    : "";
  await deleteChatSessionsHard(userId, [sessionId]);

  if (reconsiderEnabled && snapshot.length > 0) {
    const scopes: ProfileScope[] = [{ kind: "user", userId }];
    if (chatSession.projectId) {
      scopes.push({
        kind: "project",
        userId,
        projectId: chatSession.projectId,
      });
    }
    for (const scope of scopes) {
      enqueueProfileReconsideration(scope, {
        deletedSessionId: sessionId,
        snapshot,
      }).catch((error: unknown) => {
        console.error("[sessions] profile reconsider enqueue failed", error);
      });
    }
  }

  return { deleted: true, hadActiveRun };
}
```

**session-list.ts:** change `function extractTextFromMessageJson` → `export function extractTextFromMessageJson`.

## Task 5: Backend — profile queue pending reconsideration

**Files:**
- Modify: `apps/api/src/modules/profiling/queue.ts`

Append (after `takeNeedsProfileRefresh`):

```ts
// ─── Session-deletion reconsideration ──────────────────────────────────────
// Deleting a chat must not lose profile facts, but the profile should be
// re-examined: the summarizer (same worker, same queue, one LLM call) may
// remove facts that were clearly learned only from the deleted conversation.

export type PendingReconsideration = {
  deletedSessionId: string;
  snapshot: string;
  requestedAt: string;
};

const RECONSIDER_KEY_TTL_SECONDS = 86400;
const RECONSIDER_MAX_PENDING = 5;
const reconsiderKey = (scope: ProfileScope) =>
  `profile:reconsider:${profileJobId(scope)}`;

export async function getPendingReconsiderations(
  scope: ProfileScope,
): Promise<PendingReconsideration[]> {
  const raw = await getRedis().get(reconsiderKey(scope));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is PendingReconsideration =>
          !!item &&
          typeof item === "object" &&
          typeof (item as PendingReconsideration).deletedSessionId === "string" &&
          typeof (item as PendingReconsideration).snapshot === "string",
      );
    }
  } catch {
    // Malformed key — ignore; the next enqueue overwrites it.
  }
  return [];
}

/** Append a pending reconsideration (capped list); always keeps a job scheduled. */
export async function enqueueProfileReconsideration(
  scope: ProfileScope,
  info: Omit<PendingReconsideration, "requestedAt">,
): Promise<void> {
  const existing = await getPendingReconsiderations(scope);
  const next = [
    ...existing,
    { ...info, requestedAt: new Date().toISOString() },
  ].slice(-RECONSIDER_MAX_PENDING);
  await getRedis().set(
    reconsiderKey(scope),
    JSON.stringify(next),
    "EX",
    RECONSIDER_KEY_TTL_SECONDS,
  );
  await enqueueProfileRefresh(scope);
}

/** Clear pending reconsiderations after a successful profile pass. */
export async function clearPendingReconsiderations(
  scope: ProfileScope,
): Promise<void> {
  await getRedis().del(reconsiderKey(scope));
}
```

**Verify Tasks 4+5:** `pnpm --filter api build` silent (both import each other's symbols).
**Commit** `feat(api): stop-then-delete chat sessions with profile reconsideration enqueue`

---

## Task 6: Backend — profile service: reconsideration-aware summarization + worker

**Files:**
- Modify: `apps/api/src/modules/profiling/service.ts`
- Modify: `apps/api/src/modules/profiling/worker.ts`

**service.ts:**

1. Imports: add `normalizeProfileSections` from `@assingment/agent`; add `import type { PendingReconsideration } from "./queue.js";` (type-only — queue.ts is safe, but service is imported by tests indirectly; type import is erased anyway).
2. `toProfileData`: `const sections = normalizeProfileSections(row.sections ?? {});` and explicit facts map adds `source` passthrough:

```ts
const source =
  fact.source && typeof fact.source === "object" && !Array.isArray(fact.source)
    ? (fact.source as Record<string, unknown>)
    : undefined;
return {
  section: typeof fact.section === "string" ? (fact.section as ProfileSectionKey) : null,
  fact: typeof fact.fact === "string" ? fact.fact : "",
  createdAt: typeof fact.createdAt === "string" ? fact.createdAt : "",
  ...(source && typeof source.sessionId === "string"
    ? {
        source: {
          sessionId: source.sessionId,
          ...(typeof source.messageId === "string" ? { messageId: source.messageId } : {}),
        },
      }
    : {}),
};
```

3. `loadProfileDelta`: add `memorySession: { select: { sessionId: true } }` to select; push `sessionId: row.memorySession.sessionId`.
4. `appendExplicitFact` input gains `source?: { sessionId: string; messageId?: string | null } | null`; push `...(...)` conditional.

```ts
facts.push({
  section: input.section,
  fact: input.fact,
  createdAt: new Date().toISOString(),
  ...(input.source ? { source: input.source } : {}),
});
```

5. `summarizeProfileForScope(scope, opts?: { reconsiderations?: PendingReconsideration[] })`:

```ts
const existing = await loadProfileData(scope);
const since = existing?.lastProcessedAt ?? new Date(0);
const delta = await loadProfileDelta(scope, since);
const reconsiderations = opts?.reconsiderations?.length
  ? opts.reconsiderations
  : undefined;
if (delta.length === 0 && !reconsiderations) {
  return { processed: 0, watermark: existing?.lastProcessedAt ?? null };
}

const { sections, usage } = await summarizeProfileDelta({
  model: profileConfig().model,
  existing: existing ?? { sections: EMPTY_PROFILE_SECTIONS, explicitFacts: [] },
  delta,
  ...(reconsiderations ? { reconsiderations } : {}),
});
// ... usage log unchanged ...
const watermark =
  delta.length > 0
    ? new Date(delta[delta.length - 1]!.createdAt)
    : existing?.lastProcessedAt ?? new Date();
await saveProfileResult(scope, { sections, watermark });
return { processed: delta.length, watermark };
```

**worker.ts:**

```ts
import {
  PROFILE_QUEUE,
  clearPendingReconsiderations,
  getPendingReconsiderations,
  profileJobId,
  setNeedsProfileRefresh,
  takeNeedsProfileRefresh,
  type ProfileRefreshJobData,
} from "./queue.js";
```

In `processProfileJob`, before `summarizeProfileForScope`:

```ts
const reconsiderations = await getPendingReconsiderations(scope);
const result = await summarizeProfileForScope(
  scope,
  reconsiderations.length > 0 ? { reconsiderations } : undefined,
);
const processed = result.processed;

// Consume pending reconsiderations only after a successful pass, so a
// failed job retry still re-runs the reconsideration.
await clearPendingReconsiderations(scope);
```

**Verify:** `pnpm --filter api build` silent (agent types from Task 7 must exist — implement Task 7 before this compiles; see below).
**Commit** `feat(api): reconsider profile inside existing summarize job`

---

## Task 7: Agent package — profile provenance types, bullets, summarizer

**Files:**
- Modify: `packages/agent/src/profiling/types.ts`
- Modify: `packages/agent/src/profiling/profile-tool.ts`
- Modify: `packages/agent/src/profiling/profile-summarizer.ts`
- Create: `packages/agent/src/profiling/profile-summarizer.test.ts`

**types.ts** (full file):

```ts
export const PROFILE_SECTION_KEYS = [
  "facts",
  "preferences",
  "interests",
  "expertise",
  "goals",
] as const;

export type ProfileSectionKey = (typeof PROFILE_SECTION_KEYS)[number];

/** One bullet of a summarized section with its provenance (session ids). */
export type ProfileBullet = {
  text: string;
  sources: string[];
};

export type ProfileSections = Record<ProfileSectionKey, ProfileBullet[]>;

/** Which conversation produced an explicit fact (remember tool). */
export type ProfileFactSource = {
  sessionId: string;
  messageId?: string | null;
};

export type ExplicitFact = {
  section: ProfileSectionKey | null;
  fact: string;
  createdAt: string;
  /** Provenance of the conversation that produced this fact. */
  source?: ProfileFactSource | null;
};

export type ProfileScope =
  | { kind: "user"; userId: string }
  | { kind: "project"; userId: string; projectId: string };

export type ProfileData = {
  sections: ProfileSections;
  explicitFacts: ExplicitFact[];
};

/** One user-originated message included in the summarizer input. */
export type ProfileDeltaMessage = {
  createdAt: string;
  text: string;
  /** Source chat session of this message (rendered as a prompt tag). */
  sessionId: string;
};

export const EMPTY_PROFILE_SECTIONS: ProfileSections = {
  facts: [],
  preferences: [],
  interests: [],
  expertise: [],
  goals: [],
};

/** Defensive normalization for legacy/unknown bullet storage shapes. */
export function normalizeProfileBullet(value: unknown): ProfileBullet {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return {
        text: record.text,
        sources: Array.isArray(record.sources)
          ? record.sources.filter((item): item is string => typeof item === "string")
          : [],
      };
    }
  }
  return { text: typeof value === "string" ? value : "", sources: [] };
}

/** Normalize stored sections JSON (new {text, sources} or legacy string lists). */
export function normalizeProfileSections(value: unknown): ProfileSections {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return Object.fromEntries(
    PROFILE_SECTION_KEYS.map((key) => {
      const items = Array.isArray(record[key]) ? (record[key] as unknown[]) : [];
      return [key, items.map(normalizeProfileBullet).filter((b) => b.text)];
    }),
  ) as ProfileSections;
}
```

**profile-tool.ts:**

```ts
export type RememberUserProfileDeps = {
  scope: ProfileScope;
  /** Provenance of this run (which conversation is asking to remember). */
  source: { sessionId: string; messageId: string | null };
  /** Wait for a running background refresh of this scope before writing. */
  waitForActiveJob: () => Promise<void>;
  /** Persist the fact immediately; never fails the chat run. */
  appendFact: (input: {
    section: string | null;
    fact: string;
    source: { sessionId: string; messageId: string | null };
  }) => Promise<void>;
  /** Incrementally summarize the unprocessed delta of this scope. */
  refreshNow: () => Promise<{ processed: number }>;
  /** Open a fresh debounce window for the background worker. */
  reschedule: () => Promise<void>;
};
```

In `execute`: `await deps.appendFact({ section: section ?? null, fact, source: deps.source });`

**profile-summarizer.ts:**

```ts
export const profileBulletSchema = z.object({
  text: z.string(),
  sources: z.array(z.string()).default([]),
});

export const profileSectionsSchema = z.object({
  sections: z.object({
    facts: z.array(profileBulletSchema).default([]),
    preferences: z.array(profileBulletSchema).default([]),
    interests: z.array(profileBulletSchema).default([]),
    expertise: z.array(profileBulletSchema).default([]),
    goals: z.array(profileBulletSchema).default([]),
  }),
});
```

Instructions gain one line (before "Infer only..."):

```
"For each bullet based on NEW MESSAGES, list the supporting conversation ids from the (session <id>) tags as its sources. Bullets kept from the EXISTING PROFILE retain their existing sources. Omit sources when uncertain.",
```

`renderProfileContextText`: bullets via `profile.sections[key] ?? []` and `item.text`; remembered facts render as `{ text: f.fact, sources: [] }`.

`buildProfileSummaryText` — delta lines with session tags, explicit facts with source tag, and reconsideration block:

```ts
export function buildProfileSummaryText(input: {
  existing: ProfileData;
  delta: ProfileDeltaMessage[];
  reconsiderations?: Array<{ deletedSessionId: string; snapshot: string }>;
}): string {
  const existingLines = [
    "EXISTING PROFILE",
    renderProfileContextText(input.existing, "Profile"),
  ].join("\n");

  const factLines =
    input.existing.explicitFacts.length === 0
      ? "(none)"
      : input.existing.explicitFacts
          .map((fact: ExplicitFact) => {
            const sourceTag = fact.source?.sessionId
              ? ` (source session ${fact.source.sessionId})`
              : "";
            return `- ${fact.fact}${sourceTag}`;
          })
          .join("\n");

  const deltaLines =
    input.delta.length === 0
      ? "(none)"
      : input.delta
          .map(
            (message) =>
              `[${message.createdAt}] (session ${message.sessionId}) ${message.text}`,
          )
          .join("\n");

  const reconsiderationLines = input.reconsiderations?.length
    ? [
        "",
        "DELETED CONVERSATIONS",
        input.reconsiderations
          .map(
            (item) =>
              `Session ${item.deletedSessionId} was deleted by the user. Its content was:\n${item.snapshot}`,
          )
          .join("\n\n"),
        "",
        "RE-EXAMINE the EXISTING PROFILE in light of the deleted conversations: remove bullets that were clearly learned only from those conversations and are not supported by other conversations. Keep bullets still supported elsewhere, removing the deleted session ids from their sources. Remove explicit facts whose source session matches a deleted session unless re-confirmed elsewhere. If nothing changes, return the profile unchanged.",
      ].join("\n")
    : "";

  return [
    existingLines,
    "EXPLICIT FACTS",
    factLines,
    "NEW MESSAGES",
    deltaLines,
    reconsiderationLines,
  ].join("\n\n");
}
```

`summarizeProfileDelta` input gains `reconsiderations?` and passes through.

**Test** (`profile-summarizer.test.ts`): mirror the tests below (normalizeProfileBullet passthrough/legacy/malformed; delta session tags; reconsideration block present/absent; explicit fact source tag).

**Verify:** `cd packages/agent && npx tsc --noEmit` then `npx vitest run src/profiling/profile-summarizer.test.ts`.
**Commit** `feat(agent): profile bullet provenance + reconsideration prompt`

---

## Task 8: API — wire provenance into remember tool + explicit facts

**Files:**
- Modify: `apps/api/src/modules/chat/build-run-input.ts`
- Modify: `apps/api/src/modules/chat/run-worker.ts`
- Modify: `apps/api/src/modules/profiling/service.ts` (appendExplicitFact — done in Task 6)

**build-run-input.ts:**

1. Add `import type { Message } from "@anvia/core/completion";`
2. Input type gains `promptMessage?: Message;` and destructure it.
3. Add helper before `buildChatRunInput`:

```ts
function promptClientMessageId(promptMessage: Message | undefined): string | null {
  const metadata =
    promptMessage && typeof promptMessage.metadata === "object"
      ? (promptMessage.metadata as Record<string, unknown>)
      : undefined;
  return typeof metadata?.clientMessageId === "string"
    ? metadata.clientMessageId
    : null;
}
```

4. Tool wiring:

```ts
profileTool = createRememberUserProfileTool({
  scope: profileScope,
  source: {
    sessionId,
    messageId: promptClientMessageId(promptMessage),
  },
  waitForActiveJob: () => waitForActiveProfileJob(profileScope),
  appendFact: (factInput) =>
    appendExplicitFact(profileScope, {
      section: factInput.section as ProfileSectionKey | null,
      fact: factInput.fact,
      source: {
        sessionId: factInput.source.sessionId,
        messageId: factInput.source.messageId,
      },
    }),
  refreshNow: () => summarizeProfileForScope(profileScope),
  reschedule: () => rescheduleProfileRefresh(profileScope),
});
```

**run-worker.ts:** add `promptMessage,` to the `buildChatRunInput({ ... })` call.

**Verify:** `pnpm --filter api build` silent + `pnpm --filter api test`.
**Commit** `feat(api): capture session provenance on remembered facts`

---

## Task 9: Backend — router endpoints (rename + delete)

**Files:**
- Modify: `apps/api/src/modules/chat/router.ts`

Imports: add `ChatSessionNotFoundError`, `normalizeSessionTitle`, `renameChatSession` from `./chat-session.js`; `deleteChatSession`, `SessionRunActiveError` from `./session-delete.js`.

Routes (after `POST /sessions/draft`):

```ts
.patch("/sessions/:id", async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const title = typeof body?.title === "string" ? body.title : "";
  const normalized = normalizeSessionTitle(title);
  if (!normalized) {
    return c.json({ error: "title is required" }, 400);
  }

  try {
    const session = await renameChatSession({
      userId: user.id,
      sessionId: c.req.param("id"),
      title: normalized,
    });
    return c.json({
      sessionId: session.id,
      projectId: session.projectId,
      title: session.title,
      updatedAt: session.updatedAt.toISOString(),
    });
  } catch (error) {
    if (error instanceof ChatSessionNotFoundError) {
      return c.json({ error: error.message, code: error.code }, 404);
    }
    throw error;
  }
})
.delete("/sessions/:id", async (c) => {
  const user = c.get("user");
  const confirmQuery = c.req.query("confirm");
  const confirm = confirmQuery === "true" || confirmQuery === "1";
  if (!confirm) {
    return c.json(
      {
        error: "Cascade delete requires confirm=true",
        code: "CONFIRM_REQUIRED",
      },
      400,
    );
  }

  try {
    const result = await deleteChatSession(user.id, c.req.param("id"));
    return c.json(result);
  } catch (error) {
    if (error instanceof ChatSessionNotFoundError) {
      return c.json({ error: error.message, code: error.code }, 404);
    }
    if (error instanceof SessionRunActiveError) {
      return c.json({ error: error.message, code: error.code }, 409);
    }
    throw error;
  }
})
```

**Verify:** `pnpm --filter api build` silent (check exit!), `pnpm --filter api test`.
**Commit** `feat(api): rename + delete chat session endpoints`

---

## Task 10: Platform — API client + profile types

**Files:**
- Modify: `apps/platform/src/lib/api.ts`

Add after `getOrCreateEmptyChatSession`:

```ts
/** Rename a chat session (server normalizes: trim, collapse, max 48 chars). */
export async function renameSession(
  sessionId: string,
  title: string,
): Promise<{ sessionId: string; title: string }> {
  const response = await apiFetch(
    `${API_BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to rename chat");
  }
  const data = (await response.json()) as { sessionId?: unknown; title?: unknown };
  return {
    sessionId: String(data.sessionId ?? sessionId),
    title: String(data.title ?? title),
  };
}

/** Permanently delete a chat session (confirm required server-side). */
export async function deleteChatSession(
  sessionId: string,
): Promise<{ deleted: true }> {
  const response = await apiFetch(
    `${API_BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}?confirm=true`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to delete chat");
  }
  return { deleted: true };
}
```

Profile types:

```ts
export type ProfileSectionKey =
  | "facts"
  | "preferences"
  | "interests"
  | "expertise"
  | "goals";

/** One bullet of a summarized profile section with provenance session ids. */
export type ProfileBullet = {
  text: string;
  sources?: string[];
};

export type ProfileSections = Record<ProfileSectionKey, ProfileBullet[]>;

export type ExplicitFact = {
  section: ProfileSectionKey | null;
  fact: string;
  createdAt: string;
  /** Conversation that produced this fact (explicit remember tool). */
  source?: {
    sessionId?: string | null;
    messageId?: string | null;
  } | null;
};
```

**Verify:** `cd apps/platform && npx tsc --noEmit` (will fail until Task 12 — expected).
**Commit** `feat(platform): rename/delete api client + profile provenance types`

---

## Task 11: Platform — floating popover mode

**Files:**
- Modify: `apps/platform/src/components/ui/popover-menu.tsx`

Add `floating?: boolean` (default false) and `floatingOffset?: number` (default 8). When `floating`:
- Render via `createPortal(document.body)` with `fixed z-50` wrapper; `useLayoutEffect` measures anchor rect → `left: rect.right + offset`, `top: rect.top` (flip above: `Math.max(8, rect.bottom - menuHeight)` when `spaceBelow < menuHeight + 16`); initial position `{ left: -9999, top: -9999 }`.
- Close on any scroll (capture) + reposition on resize.
- Keep outside-click + Escape behavior and `align`/`className` only for the non-floating path.
- Extract the shared items JSX into a `menuItems` constant used by both branches.
- Animation: `animate-scale-in` on the floating menu (existing class).

**Verify:** `npx tsc --noEmit` + `pnpm test`.
**Commit** `feat(platform): floating portal mode for PopoverMenu`

---

## Task 12: Platform — settings UI bullet compat

**Files:**
- Modify: `apps/platform/src/components/settings/personalization-section.tsx`

`sectionEntries` items are `ProfileBullet[]`; render `item.text` in the `<li>`.

**Verify:** `npx tsc --noEmit` clean.
**Commit** `feat(platform): render profile bullets with provenance compat`

---

## Task 13: Platform — session actions menu (three-dot + dialogs)

**Files:**
- Create: `apps/platform/src/components/sidebar/session-actions.tsx`

Component `SessionActionsMenu` with props `{ session: SessionSummary; running: boolean; alwaysVisible?: boolean; onRename(sessionId, title): Promise<void>; onDelete(sessionId): Promise<void>; onRemoved(sessionId): void; restoreFocusRef? }`:
- Trigger: `MoreHorizontal` button, `size-7`, absolute `right-1.5 top-1/2 -translate-y-1/2`; classes: `opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100` unless `alwaysVisible || menuOpen`; `aria-haspopup="menu"`, `aria-expanded={menuOpen}`; stopPropagation on click.
- `PopoverMenu` with `floating`, items Rename (`Pencil`) / Delete (`Trash2`).
- Rename `DialogShell` (sm, content, `initialFocusRef`, `restoreFocusRef`), `FormTextField` (label "Name", maxLength 48, disabled while renaming, error inline), footer Cancel / Save (`form="rename-session-form"`), form submit handler. Prefill: empty when title is "New chat".
- Delete `ConfirmDialog`: description varies with `running`; `confirmLabel="Delete chat"`, busy + error; on confirm → `onDelete` → close → `onRemoved` (list plays the fade-out).
- Full code in design appendix A.

**Verify:** `npx tsc --noEmit`.
**Commit** `feat(platform): session actions menu with rename/delete dialogs`

---

## Task 14: Platform — history list rows + wiring

**Files:**
- Modify: `apps/platform/src/components/sidebar/session-history-list.tsx`
- Modify: `apps/platform/src/components/sidebar/chat-sidebar.tsx`
- Modify: `apps/platform/src/components/layout/app-shell.tsx`
- Modify: `apps/platform/src/routes/index.tsx`

**session-history-list.tsx:**
- Props gain `onRenameSession`, `onDeleteSession`, `onRemoveSession`.
- `exitingIds` state + `handleRemoved` (add to set → setTimeout 220ms → remove from set + `onRemoveSession`).
- Row: `<li className={`group/row stagger-item relative ${exiting ? "animate-fade-out" : ""}`}>` wrapping a `relative flex ... rounded-xl py-1 pl-3.5 pr-1.5` div; hover bg on the wrapper (`group-hover/row:bg-white/[0.035]`), selected → `glass-pane`; select button (flex-1, truncate, unread dot, running spinner) + `<SessionActionsMenu ... alwaysVisible={selected} onRemoved={handleRemoved} />`.

**chat-sidebar.tsx / app-shell.tsx:** plumb the three props through.

**routes/index.tsx (Home):**

```ts
const sessionsRef = useRef(sessions);
sessionsRef.current = sessions;

const handleRenameSession = useCallback(
  async (targetSessionId: string, title: string) => {
    const renamed = await renameSession(targetSessionId, title);
    setSessions((current) =>
      current.map((s) =>
        s.sessionId === targetSessionId ? { ...s, title: renamed.title } : s,
      ),
    );
  },
  [],
);

const handleDeleteSession = useCallback(
  async (targetSessionId: string) => {
    try {
      await deleteChatSession(targetSessionId);
    } catch (error) {
      if (error instanceof ApiAuthError) {
        handleAuthFailure();
        return;
      }
      throw error; // surfaced by the confirm dialog (e.g. still processing)
    }

    if (
      sessionIdRef.current === targetSessionId &&
      (viewModeRef.current === "standalone" ||
        viewModeRef.current === "project-workspace")
    ) {
      const rest = sessionsRef.current.filter(
        (s) => s.sessionId !== targetSessionId,
      );
      const empty = findEmptyNewChat(rest);
      const replacement = empty ?? rest[0] ?? null;
      if (replacement) {
        setSessionId(replacement.sessionId);
        if (viewModeRef.current === "standalone") {
          persistLastStandaloneSessionId(replacement.sessionId);
        }
      } else {
        const projectId =
          viewModeRef.current === "project-workspace"
            ? activeProjectIdRef.current
            : null;
        try {
          const draft = await getOrCreateEmptyChatSession({ projectId });
          setSessionId(draft.sessionId);
          if (!projectId) persistLastStandaloneSessionId(draft.sessionId);
        } catch (error) {
          console.error("[sessions] draft after delete failed", error);
        }
      }
    }

    setActiveRuns((current) => {
      if (!current.has(targetSessionId)) return current;
      const next = new Set(current);
      next.delete(targetSessionId);
      return next;
    });
  },
  [handleAuthFailure],
);

const handleRemoveSession = useCallback((targetSessionId: string) => {
  setSessions((current) =>
    current.filter((s) => s.sessionId !== targetSessionId),
  );
}, []);
```

Wire into `<AppShell onRenameSession={...} onDeleteSession={...} onRemoveSession={...} />`. Add `renameSession` + `deleteChatSession` to the `#/lib/api` import list.

**Verify:** `npx tsc --noEmit` clean.
**Commit** `feat(platform): sidebar session menu wiring + exit animation`

---

## Task 15: Full verification

Run with explicit exit checks:

```bash
pnpm --filter api test; echo "API_TEST=$?"
pnpm --filter api build; echo "API_BUILD=$?"
cd packages/agent && npx tsc --noEmit && npx vitest run; echo "AGENT=$?"
cd apps/platform && pnpm test && npx tsc --noEmit; echo "PLATFORM=$?"
git status --short
```

All `=0`. Optional smoke test: boot API (`pnpm --filter api dev`), hit `GET /api/chat/sessions` (expect 401), `PATCH /api/chat/sessions/x` (401), `DELETE ...?confirm=true` (401), `DELETE` without confirm (401) — proves router mounts. Kill the server afterward.

Final commit: `chore: verify session rename/delete + profile provenance`

---

## Appendix A — `session-actions.tsx` (complete)

```tsx
import { useRef, useState, type RefObject } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import {
  DIALOG_PRIMARY_BUTTON_CLASS,
  DIALOG_SECONDARY_BUTTON_CLASS,
} from "#/components/ui/dialog-actions";
import { DialogShell } from "#/components/ui/dialog-shell";
import { FormTextField } from "#/components/ui/form-field";
import { PopoverMenu } from "#/components/ui/popover-menu";
import { EMPTY_CHAT_TITLE, type SessionSummary } from "#/lib/session-history";

export function SessionActionsMenu({
  session,
  running,
  alwaysVisible = false,
  onRename,
  onDelete,
  onRemoved,
  restoreFocusRef,
}: {
  session: SessionSummary;
  running: boolean;
  /** Active row: keep the trigger visible without hover. */
  alwaysVisible?: boolean;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
  /** Called after the exit animation so the parent can drop the row. */
  onRemoved: (sessionId: string) => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const openRename = () => {
    setRenameValue(session.title === EMPTY_CHAT_TITLE ? "" : session.title);
    setRenameError(null);
    setRenameOpen(true);
  };

  const submitRename = async () => {
    if (renaming) return;
    const title = renameValue.trim();
    if (!title) {
      setRenameError("Give this chat a name");
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      await onRename(session.sessionId, title);
      setRenameOpen(false);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : "Could not rename chat");
    } finally {
      setRenaming(false);
    }
  };

  const submitDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(session.sessionId);
      setDeleteOpen(false);
      // The list plays the row's fade-out and then drops it via onRemoved.
      onRemoved(session.sessionId);
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : "Could not delete chat");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
        <button
          ref={buttonRef}
          type="button"
          aria-label={`Chat actions for ${session.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className={`inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-muted transition duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.08] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring active:scale-95 ${
            alwaysVisible || menuOpen
              ? "opacity-100"
              : "opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
          }`}
        >
          <MoreHorizontal className="size-4" strokeWidth={1.75} />
        </button>
      </div>

      <PopoverMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={buttonRef}
        align="start"
        floating
        label="Chat actions"
        items={[
          {
            id: "rename",
            label: "Rename",
            icon: <Pencil className="size-3.5" strokeWidth={1.75} />,
            onSelect: openRename,
          },
          {
            id: "delete",
            label: "Delete",
            icon: <Trash2 className="size-3.5" strokeWidth={1.75} />,
            onSelect: () => {
              setDeleteError(null);
              setDeleteOpen(true);
            },
          },
        ]}
      />

      <DialogShell
        open={renameOpen}
        onClose={() => {
          if (renaming) return;
          setRenameOpen(false);
        }}
        title="Rename chat"
        description="Give this conversation a memorable name"
        size="sm"
        heightMode="content"
        dismissDisabled={renaming}
        initialFocusRef={nameInputRef}
        restoreFocusRef={restoreFocusRef ?? buttonRef}
        footer={
          <>
            <button
              type="button"
              disabled={renaming}
              onClick={() => setRenameOpen(false)}
              className={DIALOG_SECONDARY_BUTTON_CLASS}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="rename-session-form"
              disabled={renaming || !renameValue.trim()}
              className={DIALOG_PRIMARY_BUTTON_CLASS}
            >
              {renaming ? "Saving…" : "Save"}
            </button>
          </>
        }
      >
        <form
          id="rename-session-form"
          className="flex flex-col gap-4 px-4 py-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <FormTextField
            ref={nameInputRef}
            label="Name"
            name="title"
            value={renameValue}
            onChange={(event) => {
              setRenameValue(event.target.value);
              if (renameError) setRenameError(null);
            }}
            placeholder="Give this chat a name…"
            autoComplete="off"
            maxLength={48}
            disabled={renaming}
            error={renameError}
          />
        </form>
      </DialogShell>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete chat?"
        description={
          running
            ? "This conversation is still being processed. Deleting stops the run on every device, then permanently removes the conversation. Your documents and personalized preferences are not affected."
            : "This conversation and its messages will be permanently removed. Your documents and personalized preferences are not affected."
        }
        confirmLabel={deleting ? "Deleting…" : "Delete chat"}
        busy={deleting}
        error={deleteError}
        restoreFocusRef={restoreFocusRef ?? buttonRef}
        onCancel={() => {
          if (deleting) return;
          setDeleteOpen(false);
        }}
        onConfirm={() => void submitDelete()}
      />
    </>
  );
}
```

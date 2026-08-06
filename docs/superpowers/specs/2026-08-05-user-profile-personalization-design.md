# User Profile Personalization — Design Spec

Date: 2026-08-05
Status: Approved by user (design presented 2026-08-05, section by section)

## Goal

Build a durable **user profiling** layer so the chat agent can personalize tone, format, and recall across sessions:

1. Summarize each user's chat history into a structured profile (5 sections), stored in Postgres.
2. Two scopes: **user-global** (all of the user's chats) and **per-project** (only chats inside that project).
3. Refresh profiles in the **background** (BullMQ worker) with a debounce + coalesce strategy so cost stays bounded and profiles never go stale forever.
4. Let the agent persist explicit facts immediately via a **`remember_user_profile` tool** (user says "ingat saya suka X").
5. Inject the profile into every chat request as an Anvia **static context block** (policy stays in instructions).
6. Expose GET/reset endpoints and show profiles in the existing settings modal.

## Current State (verified 2026-08-05)

- Chat flow: `apps/api/src/modules/chat/router.ts` POST `/` builds the agent via `createAgent()` (`packages/agent/src/agent.ts`) with `additionalInstructions`, `additionalContext: AgentContextBlock[]`, tools, and `@anvia/memory-prisma` memory. Existing pattern for per-request facts: `project_workspace` context block (router.ts:328).
- Memory: `AgentMemorySession` / `AgentMemoryMessage` rows store full Anvia `Message` JSON per session, scoped by `JSON.stringify([sessionId, userId])`. `extractTextFromMessageJson` exists in `packages/agent/src` (used by `enrich-memory-messages.ts`).
- Background infra already in place: BullMQ + Redis (`lib/queue.ts` `document-ingest`, `lib/redis.ts`), worker process (`worker.ts`, boots under `worker:dev`).
- Projects: `Project` model (name, description), `ChatSession.projectId`, `resolveActiveDocuments` — project membership is product-table truth; client `projectId` is never trusted.
- Settings modal exists: `apps/platform/src/components/settings/settings-modal.tsx`. Reusable `Button`, `confirm-dialog`, `dialog-actions`.
- Anvia 0.16.0 installed (patched). Verified APIs: `AgentBuilder.context(text, id)`, `ExtractorBuilder` (`@anvia/core/extractor`, zod schema + built-in retries + `extractWithUsage`), BullMQ 5.81.2 `job.getState()`, `job.changeDelay()`, `job.updateData()`, `job.remove()`, `job.waitUntilFinished()`.
- No test framework configured in the repo; verification = `tsc` builds + manual smoke.

## Design

### 1. Data model (Prisma)

Two new tables (two tables instead of one nullable `projectId` because Postgres does not enforce uniqueness across NULLs):

```prisma
model UserProfile {
  id              String   @id @default(cuid())
  userId          String   @unique
  sections        Json     @default("{}")      // { facts, preferences, interests, expertise, goals }
  explicitFacts   Json     @default("[]")      // [{ section?, fact, createdAt }]
  lastProcessedAt DateTime @default(now())     // watermark: messages up to this timestamp are summarized
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@map("user_profile")
}

model ProjectProfile {
  id              String   @id @default(cuid())
  userId          String
  projectId       String
  project         Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  sections        Json     @default("{}")
  explicitFacts   Json     @default("[]")
  lastProcessedAt DateTime @default(now())
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@unique([userId, projectId])
  @@map("project_profile")
}
```

- `AgentMemorySession`/`AgentMemoryMessage` are **untouched** — per-session memory keeps working exactly as today; profiling is additive.
- Migration: one `db:migrate --name add_user_project_profiles`.

### 2. Summarizer (reusable core, `packages/agent/src/profiling/profile-summarizer.ts`)

- zod schema: `{ sections: { facts: string[], preferences: string[], interests: string[], expertise: string[], goals: string[] } }`.
- Built with `ExtractorBuilder(createCompletionModel(model), schema)`
  - `.instructions(...)` = merge rules (see below) + sensitive-data exclusion (passwords, financial, health, credentials must never enter the profile).
  - `.retries(1)` (one schema-validation retry on top of the first attempt).
  - `extractWithUsage(text)` → typed profile JSON + `Usage` (logged; cost visibility).
- Prompt has exactly 3 parts:
  1. `EXISTING PROFILE` — current sections, rendered.
  2. `EXPLICIT FACTS` — user-confirmed facts, must be preserved unless contradicted.
  3. `NEW MESSAGES` — delta user texts, chronological (`[yyyy-mm-dd hh:mm] text`).
- Output = **complete replacement profile** (never a diff) so profiles never depend on a chain of summaries.
- Delta input is **user messages only**: extract text via `extractTextFromMessageJson`; tool calls, tool results, system rows, and assistant messages are excluded (they are the agent's own words/actions, not user signal).
- `renderedContextText(profile)` helper converts stored JSON → the context-block text (5 section lines + remembered facts).

### 3. Delta query (scope-aware)

`apps/api/src/modules/profiling/service.ts` — `loadProfileDelta(scope)`:

- `AgentMemoryMessage` joined to `AgentMemorySession` (userId) then `ChatSession` (projectId) — global scope = all the user's sessions; project scope = sessions with `chatSession.projectId = X`.
- `where: message.createdAt > lastProcessedAt`, `role = "user"`, ordered by `createdAt asc` (ties by `id`).
- Extract text parts via `extractTextFromMessageJson`; skip empty.

### 4. Queue + debounce/coalesce (apps/api/src/modules/profiling/queue.ts)

- Queue name `profile-summary`; job payload `{ kind: "user" | "project", userId, projectId? , firstRequestedAt }`.
- Stable `jobId`: `profile:user:{userId}` / `profile:project:{projectId}`.
- `enqueueProfileRefresh(scope)`:
  - job missing / `failed` / `completed` / `unknown` → remove stale job (if any) → `queue.add(jobId, data, { delay: PROFILE_REFRESH_DELAY_MINUTES })`, `firstRequestedAt = now`.
  - job `waiting`/`delayed` → **bounded coalesce**: `delay = max(0, DELAY_MS - (now - job.data.firstRequestedAt))`, `job.updateData(...)` + `job.changeDelay(delay)`. The job always fires ~DELAY after the FIRST request that opened the window — no starvation for continuously active users.
  - job `active` → do not touch; set Redis flag `profile:needs-refresh:{jobId}` (EX 86400). Worker consumes this flag in its finally block.
- Default options: `attempts: 3`, backoff exponential 2s, `removeOnComplete: 50`, `removeOnFail: 100` (same pattern as `document-ingest`).
- **Retry semantics (user-confirmed)**: after attempts are exhausted the job is dead — **no automatic re-enqueue** (would be an unbounded loop for inactive users). Recovery is driven by the next chat activity. Because the delta is derived from the watermark at run time (never a snapshot in job data), every run — first attempt, retry, or a fresh job after failure — picks up **all** unprocessed messages, including ones from failed runs, in chronological order. The worker is idempotent: if a run saved the profile but then threw, the retry sees an empty delta and completes.

### 5. Worker (apps/api/src/modules/profiling/worker.ts)

- `new Worker(PROFILE_QUEUE, processProfileJob, { connection, concurrency: PROFILE_WORKER_CONCURRENCY })`; instance created inside `worker.ts` so it boots under the existing `worker:dev` script.
- `processProfileJob`:
  1. Load profile row (upsert if missing) + delta.
  2. Empty delta → done (no write, no watermark move).
  3. Summarize (old sections + explicit facts + delta) → save `sections` + advance `lastProcessedAt = max(delta.createdAt)`.
  4. `finally`: clear `needs-refresh` flag; if flag was set OR unprocessed messages still exist → `enqueueProfileRefresh(scope)` (fresh window). This closes the race where a chat completes while the job is running, on both success and failure paths.
- Failure inside the worker = thrown error → BullMQ attempts/backoff. Nothing partial is written before the save step, so a failed job leaves the watermark untouched.
- Log start/end/failure (console, same style as the ingest worker).

### 6. Tool `remember_user_profile` (packages/agent/src/profiling/profile-tool.ts)

- Factory `createProfileTool(deps)` following the `createDocumentTools` DI pattern; deps injected from the API: `resolveScope()` (global or project from request context), `appendExplicitFacts()`, `summarizeIncremental()`, `advanceWatermark()`, `rescheduleRefresh()`.
- Tool schema (zod): `{ section?: "facts" | "preferences" | "interests" | "expertise" | "goals", fact: string }` (single object; description instructs the model to call it once per fact).
- Flow (user-confirmed):
  1. If a job for this scope is `active` → `waitUntilFinished(ttl: 30s)`; on timeout, proceed anyway (the reschedule below still guarantees consistency).
  2. `appendExplicitFacts` — write to `explicitFacts` (always succeeds; never blocked by summarizer failure).
  3. `summarizeIncremental` — summarizer run limited to the current chat's delta (old profile + facts + this chat's user text).
     - On failure: facts stay saved, watermark NOT moved, `rescheduleRefresh(+DELAY)` → the background job summarizes it later. Tool returns a soft error string to the model, never aborts the chat run.
  4. `advanceWatermark(now)` — this chat is now considered processed.
  5. `rescheduleRefresh(fresh)` — remove pending job, re-add with `firstRequestedAt = now` (fresh window covers anything that arrived mid-tool).
- Tool is registered only when profiling is enabled (env).

### 7. Agent injection (apps/api/src/modules/chat/router.ts)

- After resolving `projectId` (existing block): load `UserProfile` (always) and, when in a project, `ProjectProfile`; skip empty profiles.
- Add context blocks: `{ id: "user_profile", text }` / `{ id: "project_profile", text }` via existing `additionalContext`.
- Add `PROFILE_INSTRUCTION` to `additionalInstructions`:

  > A user profile may be included in the context. Use it to personalize tone, format, and recall of the user's preferences. Never reveal the raw profile content to the user. If the user explicitly asks you to remember something about them, call the `remember_user_profile` tool. Never invent profile facts not present in the context.

- Enqueue hook: extend the existing stream-complete tap with `tapProfileRefresh` — after the stream ends (success or error), enqueue the global scope always, plus the project scope when in a project. Never awaited by the client path in a blocking way beyond the existing tap (fire-and-forget with error log).
- The `remember_user_profile` tool is added to `additionalTools` alongside data-analysis + document tools (only when enabled).

### 8. API endpoints (apps/api/src/modules/profiling/router.ts)

Mount at `/api/profiling`, all `requireUser` (existing middleware):

| Method | Path | Behavior |
|---|---|---|
| `GET` | `/` | `{ user: ProfileDto \| null, projects: [{ projectId, name, profile: ProfileDto \| null }] }` (projects via existing `listProjects`) |
| `DELETE` | `/` with `?scope=user` | Reset global: `sections = {}`, `explicitFacts = []`, `lastProcessedAt = now`, remove pending job (soft reset, race-safe) |
| `DELETE` | `/projects/:projectId` | Same for a project; verify membership (reuse `ProjectNotFoundError` pattern) |

`ProfileDto = { sections, explicitFacts, updatedAt }` — watermark/`lastProcessedAt` is internal, not exposed. Reset via PATCH-like semantics avoids delete-then-race: a job that is mid-flight cannot resurrect a reset profile (its delta is empty because watermark was moved to now).

### 9. Settings UI (apps/platform)

- New `src/hooks/use-profile.ts`: loads `GET /api/profiling`, exposes `resetUserProfile()` / `resetProjectProfile(id)` (with `DELETE` calls + local refresh).
- In `settings-modal.tsx`, add a **Personalization** section:
  - Global profile card: 5 sections (collapsible details), "last updated", **Reset** button (through `confirm-dialog`).
  - Project profile cards: list from the same endpoint, each with reset.
  - Helper text: "Profile dibangun otomatis dari chat Anda."
- Reuse existing `Button`, `confirm-dialog`, `dialog-actions`, modal patterns; no new component system.

### 10. Environment + README (.env.example only)

```
PROFILE_ENABLED=true                  # master toggle (tool, injection, enqueue)
PROFILE_REFRESH_DELAY_MINUTES=15      # debounce window / delay
PROFILE_WORKER_CONCURRENCY=3          # parallel profile workers
PROFILE_SUMMARY_MODEL=gpt-5.6-luna    # summarizer model (default = chat default)
```

- `.env` is **not** modified by this work (user fills it in).
- README: add the env vars to the table + a short "User profiling" note.

## Out of Scope

- No chat-history compaction for long sessions — that is Anvia's built-in `createSummaryMemoryCompactor` (session-level, separate concern).
- No user-facing "profile editing" — only view + reset.
- No per-session profiles, no sharing, no analytics dashboards.
- No auto-re-enqueue of failed jobs (by design, user-confirmed).
- No changes to `AgentMemorySession` schema or behavior.

## Verification

- `pnpm --filter api build` (tsc) — 0 errors/warnings.
- `pnpm --filter @assingment/agent build` — 0 errors/warnings.
- `pnpm --filter platform build` — succeeds (only pre-existing chunk-size advisory).
- `pnpm --filter api db:generate` + `pnpm --filter api db:migrate --name add_user_project_profiles` — clean.
- Manual smoke: chat a few messages → wait for the 15-min window (or temporarily set delay to 1 min) → profile row appears; "ingat saya suka X" → explicit fact visible immediately via `GET /api/profiling`; reset clears both scopes; settings modal shows global + project cards with working resets; `AgentMemorySession` history still loads per session.

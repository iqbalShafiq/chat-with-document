# User Profile Personalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable user-profiling layer (user-global + per-project) that summarizes chat history in the background via a debounced BullMQ worker and injects the profile into every chat request as Anvia context, plus an `remember_user_profile` tool for explicit facts and a settings UI to view/reset profiles.

**Architecture:** Profile rows live in Postgres (`UserProfile`/`ProjectProfile`) keyed by scope, with a `lastProcessedAt` watermark. Chat completions enqueue a coalesced delayed BullMQ job (`profile-summary`, stable jobId per scope, bounded debounce window). The worker re-derives the delta (user messages after the watermark) at run time, merges old profile + explicit facts + delta through an Anvia `ExtractorBuilder` (zod structured output), saves the full replacement profile, and advances the watermark. Profiles are injected as static context blocks; policy lives in instructions. A tool writes explicit facts immediately and reschedules the window.

**Tech Stack:** Prisma 7 + Postgres, BullMQ 5.81 (Redis), Hono, `@anvia/core` 0.16 (`ExtractorBuilder` from `@anvia/core/extractor`, `createTool`), zod v4, React 19 + Tailwind 4, TypeScript strict.

## Global Constraints

- **No test framework is configured in this repo.** Verification = `tsc` typecheck/build per task + manual smoke (final task). Never invent a test runner.
- `packages/agent/tsconfig.json` enables `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` — optional fields must be assigned explicitly (`x ?? undefined`), indexed access must be null-checked.
- Repo style: ESM (`"type": "module"`), imports use `.js` extensions, `verbatimModuleSyntax` (use `import type` for types), zod imported as `import z from "zod"`, Prisma client from `apps/api/src/generated/prisma` via `../../utils/prisma.js`.
- Anvia rule (from docs): instructions = durable behavior/policy; context = request facts. User profile is a **fact** → context block, never instructions. Never put user id/tenant ids in instructions.
- Scope/authorization: always derive `userId`/`projectId` from server-side state (`requireUser`, `ChatSession.projectId`) — never trust client payloads.
- `.env` is NOT modified; config goes to `.env.example` only.
- Defaults (spec-approved): delay 15 min, worker concurrency 3, `PROFILE_SUMMARY_MODEL` defaults to `DEFAULT_COMPLETION_MODEL`.
- Retry semantics (user-confirmed): `attempts: 3` exponential backoff; after exhaustion the job is dead — **no auto-re-enqueue**; recovery happens on the next chat. Worker is idempotent via watermark.
- Profile content must exclude sensitive data (passwords, credentials, financial, health) — enforced in the summarizer instructions.

---

### Task 1: Prisma schema — UserProfile + ProjectProfile

**Files:**
- Modify: `apps/api/prisma/schema.prisma` (append two models after the `Project`/`ChatSession` block, ~line 156)

**Interfaces:**
- Produces: `prisma.userProfile` and `prisma.projectProfile` delegates with fields `id`, `userId`, `projectId` (project only), `sections Json`, `explicitFacts Json`, `lastProcessedAt DateTime`, `createdAt`, `updatedAt`.

- [ ] **Step 1: Add the models**

```prisma
// ─── User profiling (personalization layer; additive to AgentMemory*) ──────

model UserProfile {
  id              String   @id @default(cuid())
  userId          String   @unique
  /// Profile sections from the summarizer: { facts, preferences, interests, expertise, goals }
  sections        Json     @default("{}")
  /// Explicit facts from remember_user_profile tool: [{ section, fact, createdAt }]
  explicitFacts   Json     @default("[]")
  /// Watermark: user messages with createdAt <= this value are summarized.
  lastProcessedAt DateTime @default(now())
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
  @@index([userId])
  @@map("project_profile")
}
```

- [ ] **Step 2: Regenerate + migrate**

```bash
pnpm --filter api db:generate
pnpm --filter api db:migrate --name add_user_project_profiles
```

Expected: client regenerated into `apps/api/src/generated/prisma`; migration `20260805xxxxxx_add_user_project_profiles` applied.

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter api build
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat: add user and project profile tables"
```

---

### Task 2: Profile domain types + summarizer (packages/agent)

**Files:**
- Create: `packages/agent/src/profiling/types.ts`
- Create: `packages/agent/src/profiling/profile-summarizer.ts`
- Modify: `packages/agent/src/index.ts` (add exports)

**Interfaces:**
- Consumes: `extractTextFromMessageJson` (already exported from `@assingment/agent`), `createCompletionModel` (`./providers/openai.js`), `ExtractorBuilder` from `@anvia/core/extractor`, `zod`.
- Produces (consumed by Tasks 3–8):
  - `PROFILE_SECTION_KEYS`, `ProfileSectionKey`, `ProfileSections`, `ExplicitFact`, `ProfileScope`, `ProfileData`, `ProfileDeltaMessage`, `EMPTY_PROFILE_SECTIONS`
  - `profileSectionsSchema` (zod)
  - `PROFILE_SUMMARY_INSTRUCTIONS` (string)
  - `buildProfileSummaryText(input: { existing: ProfileData; delta: ProfileDeltaMessage[] }): string`
  - `summarizeProfileDelta(input: { model: CompletionModel; existing: ProfileData; delta: ProfileDeltaMessage[] }): Promise<{ sections: ProfileSections; usage: Usage }>` (throws `ExtractionError` on failure)
  - `renderProfileContextText(profile: ProfileData, label: string): string`
  - `hasProfileContent(profile: ProfileData): boolean`

- [ ] **Step 1: Write `types.ts`**

```ts
export const PROFILE_SECTION_KEYS = [
  "facts",
  "preferences",
  "interests",
  "expertise",
  "goals",
] as const;

export type ProfileSectionKey = (typeof PROFILE_SECTION_KEYS)[number];

export type ProfileSections = Record<ProfileSectionKey, string[]>;

export type ExplicitFact = {
  section: ProfileSectionKey | null;
  fact: string;
  createdAt: string;
};

export type ProfileScope =
  | { kind: "user"; userId: string }
  | { kind: "project"; userId: string; projectId: string };

export type ProfileData = {
  sections: ProfileSections;
  explicitFacts: ExplicitFact[];
};

/** One user-originated message text included in the summarizer input. */
export type ProfileDeltaMessage = {
  createdAt: string;
  text: string;
};

export const EMPTY_PROFILE_SECTIONS: ProfileSections = {
  facts: [],
  preferences: [],
  interests: [],
  expertise: [],
  goals: [],
};
```

- [ ] **Step 2: Write `profile-summarizer.ts`**

```ts
import type { CompletionModel, Usage } from "@anvia/core";
import { ExtractorBuilder } from "@anvia/core/extractor";
import z from "zod";
import { EMPTY_PROFILE_SECTIONS } from "./types.js";
import type {
  ExplicitFact,
  ProfileData,
  ProfileDeltaMessage,
  ProfileSectionKey,
  ProfileSections,
} from "./types.js";

export const profileSectionsSchema = z.object({
  sections: z.object({
    facts: z.array(z.string()).default([]),
    preferences: z.array(z.string()).default([]),
    interests: z.array(z.string()).default([]),
    expertise: z.array(z.string()).default([]),
    goals: z.array(z.string()).default([]),
  }),
});

export const PROFILE_SUMMARY_INSTRUCTIONS = [
  "You maintain a durable user profile used to personalize future conversations.",
  "Merge the NEW MESSAGES into the EXISTING PROFILE. Keep every existing point unless a new message directly contradicts it.",
  "EXPLICIT FACTS were confirmed by the user and MUST be preserved verbatim or merged into the matching section without changing their meaning.",
  "Write each section as a list of concise, concrete, non-redundant bullet points (1-2 lines each, max 12 per section).",
  "Infer only what is clearly supported by the messages; mark uncertainty with 'possibly'.",
  "NEVER include sensitive data: passwords, credentials, tokens, financial account numbers, health records, or government IDs. Such content stays out of the profile entirely.",
  "Output the COMPLETE updated profile (a replacement, not a diff).",
].join("\n");

function renderList(items: string[]): string {
  return items.length === 0 ? "(none)" : items.map((item) => `- ${item}`).join("\n");
}

export function renderProfileContextText(profile: ProfileData, label: string): string {
  const sectionLabels: Array<[ProfileSectionKey, string]> = [
    ["facts", "Facts"],
    ["preferences", "Preferences"],
    ["interests", "Interests"],
    ["expertise", "Expertise"],
    ["goals", "Goals"],
  ];
  const lines = [label];
  for (const [key, labelText] of sectionLabels) {
    lines.push(`${labelText}:`, renderList(profile.sections[key]));
  }
  if (profile.explicitFacts.length > 0) {
    lines.push("Remembered:", renderList(profile.explicitFacts.map((f) => f.fact)));
  }
  return lines.join("\n");
}

export function hasProfileContent(profile: ProfileData): boolean {
  return (
    profile.explicitFacts.length > 0 ||
    Object.values(profile.sections).some((items) => items.length > 0)
  );
}

export function buildProfileSummaryText(input: {
  existing: ProfileData;
  delta: ProfileDeltaMessage[];
}): string {
  const existingLines = [
    "EXISTING PROFILE",
    renderProfileContextText(input.existing, "Profile"),
  ].join("\n");

  const factLines =
    input.existing.explicitFacts.length === 0
      ? "(none)"
      : input.existing.explicitFacts
          .map((fact: ExplicitFact) => `- ${fact.fact}`)
          .join("\n");

  const deltaLines =
    input.delta.length === 0
      ? "(none)"
      : input.delta.map((message) => `[${message.createdAt}] ${message.text}`).join("\n");

  return [
    existingLines,
    "EXPLICIT FACTS",
    factLines,
    "NEW MESSAGES",
    deltaLines,
  ].join("\n\n");
}

export async function summarizeProfileDelta(input: {
  model: CompletionModel;
  existing: ProfileData;
  delta: ProfileDeltaMessage[];
}): Promise<{ sections: ProfileSections; usage: Usage }> {
  const text = buildProfileSummaryText(input);
  const extractor = new ExtractorBuilder(input.model, profileSectionsSchema)
    .instructions(PROFILE_SUMMARY_INSTRUCTIONS)
    .retries(1)
    .build();

  const result = await extractor.extractWithUsage(text);
  return {
    sections: {
      ...EMPTY_PROFILE_SECTIONS,
      ...result.data.sections,
    },
    usage: result.usage,
  };
}
```

Note: `ExplicitFact` import is used by `buildProfileSummaryText`'s `.map` annotation — if the compiler flags it as unused, drop the annotation and rely on inference (check with the typecheck step).

- [ ] **Step 3: Export from `packages/agent/src/index.ts`**

```ts
export * from "./profiling/types.js";
export * from "./profiling/profile-summarizer.js";
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @assingment/agent exec tsc --noEmit
```

Expected: 0 errors. (`ExactOptionalPropertyTypes` is on — ensure no optional-field assignments that skip `undefined`.)

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/profiling packages/agent/src/index.ts
git commit -m "feat: add profile types and zod-validated profile summarizer"
```

---

### Task 3: Profiling service (apps/api)

**Files:**
- Create: `apps/api/src/modules/profiling/service.ts`

**Interfaces:**
- Consumes: `prisma` (`../../utils/prisma.js`), `extractTextFromMessageJson` + profile types/summarizer from `@assingment/agent`, `parseCompletionModel`/`DEFAULT_COMPLETION_MODEL`/`createCompletionModel` from `@assingment/agent`.
- Produces (consumed by Tasks 4, 5, 7, 8):
  - `profileConfig(): { enabled: boolean; delayMs: number; concurrency: number; model: CompletionModel }`
  - `profileWhere(scope): { userId: string; projectId?: string }`
  - `loadProfileData(scope): Promise<ProfileData & { lastProcessedAt: Date } | null>`
  - `loadProfileDelta(scope, since: Date): Promise<ProfileDeltaMessage[]>`
  - `saveProfileResult(scope, input: { sections: ProfileSections; watermark: Date }): Promise<void>`
  - `appendExplicitFact(scope, input: { section: ProfileSectionKey | null; fact: string }): Promise<void>`
  - `advanceProfileWatermark(scope, at: Date): Promise<void>`
  - `resetProfile(scope): Promise<void>`
  - `summarizeProfileForScope(scope): Promise<{ processed: number; watermark: Date | null }>`
  - `getProfilingSettingsPayload(userId): Promise<{ user: ProfileDto | null; projects: Array<{ id: string; name: string; profile: ProfileDto | null }> }>` with `type ProfileDto = { sections: ProfileSections; explicitFacts: ExplicitFact[]; updatedAt: string }`

- [ ] **Step 1: Write the file**

```ts
import {
  extractTextFromMessageJson,
  createCompletionModel,
  DEFAULT_COMPLETION_MODEL,
  EMPTY_PROFILE_SECTIONS,
  parseCompletionModel,
  summarizeProfileDelta,
  type CompletionModel,
  type ExplicitFact,
  type ProfileData,
  type ProfileDeltaMessage,
  type ProfileScope,
  type ProfileSectionKey,
  type ProfileSections,
} from "@assingment/agent";
import { prisma } from "../../utils/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";

export type ProfileConfig = {
  enabled: boolean;
  delayMs: number;
  concurrency: number;
  model: CompletionModel;
};

export function profileConfig(): ProfileConfig {
  const enabled = process.env.PROFILE_ENABLED !== "false";
  const delayMinutes = Number(process.env.PROFILE_REFRESH_DELAY_MINUTES ?? "15");
  const concurrency = Number(process.env.PROFILE_WORKER_CONCURRENCY ?? "3");
  const modelId = parseCompletionModel(process.env.PROFILE_SUMMARY_MODEL);
  return {
    enabled,
    delayMs:
      Number.isFinite(delayMinutes) && delayMinutes > 0
        ? Math.round(delayMinutes * 60_000)
        : 15 * 60_000,
    concurrency:
      Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 3,
    model: createCompletionModel(modelId ?? DEFAULT_COMPLETION_MODEL),
  };
}

function profileWhere(scope: ProfileScope): { userId: string; projectId?: string } {
  return scope.kind === "project"
    ? { userId: scope.userId, projectId: scope.projectId }
    : { userId: scope.userId };
}

function toProfileData(row: {
  sections: Prisma.JsonValue;
  explicitFacts: Prisma.JsonValue;
}): ProfileData {
  const sections = (row.sections ?? {}) as Record<string, unknown>;
  const facts = (row.explicitFacts ?? []) as unknown[];
  return {
    sections: {
      facts: Array.isArray(sections.facts) ? (sections.facts as string[]) : [],
      preferences: Array.isArray(sections.preferences)
        ? (sections.preferences as string[])
        : [],
      interests: Array.isArray(sections.interests)
        ? (sections.interests as string[])
        : [],
      expertise: Array.isArray(sections.expertise)
        ? (sections.expertise as string[])
        : [],
      goals: Array.isArray(sections.goals) ? (sections.goals as string[]) : [],
    },
    explicitFacts: facts
      .filter((fact): fact is Record<string, unknown> => typeof fact === "object" && fact !== null)
      .map((fact) => ({
        section: typeof fact.section === "string" ? (fact.section as ProfileSectionKey) : null,
        fact: typeof fact.fact === "string" ? fact.fact : "",
        createdAt: typeof fact.createdAt === "string" ? fact.createdAt : "",
      }))
      .filter((fact) => fact.fact.length > 0),
  };
}

export async function loadProfileData(
  scope: ProfileScope,
): Promise<(ProfileData & { lastProcessedAt: Date }) | null> {
  if (scope.kind === "user") {
    const row = await prisma.userProfile.findUnique({
      where: { userId: scope.userId },
      select: { sections: true, explicitFacts: true, lastProcessedAt: true },
    });
    return row ? { ...toProfileData(row), lastProcessedAt: row.lastProcessedAt } : null;
  }

  const row = await prisma.projectProfile.findUnique({
    where: { userId_projectId: { userId: scope.userId, projectId: scope.projectId } },
    select: { sections: true, explicitFacts: true, lastProcessedAt: true },
  });
  return row ? { ...toProfileData(row), lastProcessedAt: row.lastProcessedAt } : null;
}

export async function loadProfileDelta(
  scope: ProfileScope,
  since: Date,
): Promise<ProfileDeltaMessage[]> {
  const chatSessions = await prisma.chatSession.findMany({
    where: profileWhere(scope),
    select: { id: true },
  });
  if (chatSessions.length === 0) return [];

  const rows = await prisma.agentMemoryMessage.findMany({
    where: {
      role: "user",
      createdAt: { gt: since },
      memorySession: { sessionId: { in: chatSessions.map((session) => session.id) } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { createdAt: true, message: true },
    take: 2000,
  });

  const delta: ProfileDeltaMessage[] = [];
  for (const row of rows) {
    const text = extractTextFromMessageJson(row.message).trim();
    if (!text) continue;
    delta.push({ createdAt: row.createdAt.toISOString(), text });
  }
  return delta;
}

export async function saveProfileResult(
  scope: ProfileScope,
  input: { sections: ProfileSections; watermark: Date },
): Promise<void> {
  const data = {
    sections: input.sections as unknown as Prisma.InputJsonValue,
    lastProcessedAt: input.watermark,
  };
  if (scope.kind === "user") {
    await prisma.userProfile.upsert({
      where: { userId: scope.userId },
      create: { userId: scope.userId, ...data },
      update: data,
    });
  } else {
    await prisma.projectProfile.upsert({
      where: {
        userId_projectId: { userId: scope.userId, projectId: scope.projectId },
      },
      create: { userId: scope.userId, projectId: scope.projectId, ...data },
      update: data,
    });
  }
}

export async function appendExplicitFact(
  scope: ProfileScope,
  input: { section: ProfileSectionKey | null; fact: string },
): Promise<void> {
  const existing = await loadProfileData(scope);
  const facts: ExplicitFact[] = existing?.explicitFacts ?? [];
  facts.push({
    section: input.section,
    fact: input.fact,
    createdAt: new Date().toISOString(),
  });
  const capped = facts.slice(-100);

  const data = { explicitFacts: capped as unknown as Prisma.InputJsonValue };
  if (scope.kind === "user") {
    await prisma.userProfile.upsert({
      where: { userId: scope.userId },
      create: { userId: scope.userId, sections: {} as Prisma.InputJsonValue, ...data },
      update: data,
    });
  } else {
    await prisma.projectProfile.upsert({
      where: {
        userId_projectId: { userId: scope.userId, projectId: scope.projectId },
      },
      create: {
        userId: scope.userId,
        projectId: scope.projectId,
        sections: {} as Prisma.InputJsonValue,
        ...data,
      },
      update: data,
    });
  }
}

export async function advanceProfileWatermark(
  scope: ProfileScope,
  at: Date,
): Promise<void> {
  const data = { lastProcessedAt: at };
  if (scope.kind === "user") {
    await prisma.userProfile.upsert({
      where: { userId: scope.userId },
      create: { userId: scope.userId, sections: {} as Prisma.InputJsonValue, ...data },
      update: data,
    });
  } else {
    await prisma.projectProfile.upsert({
      where: {
        userId_projectId: { userId: scope.userId, projectId: scope.projectId },
      },
      create: {
        userId: scope.userId,
        projectId: scope.projectId,
        sections: {} as Prisma.InputJsonValue,
        ...data,
      },
      update: data,
    });
  }
}

export async function resetProfile(scope: ProfileScope): Promise<void> {
  const data = {
    sections: EMPTY_PROFILE_SECTIONS as unknown as Prisma.InputJsonValue,
    explicitFacts: [] as unknown as Prisma.InputJsonValue,
    lastProcessedAt: new Date(),
  };
  if (scope.kind === "user") {
    await prisma.userProfile.upsert({
      where: { userId: scope.userId },
      create: { userId: scope.userId, ...data },
      update: data,
    });
  } else {
    await prisma.projectProfile.upsert({
      where: {
        userId_projectId: { userId: scope.userId, projectId: scope.projectId },
      },
      create: { userId: scope.userId, projectId: scope.projectId, ...data },
      update: data,
    });
  }
}

/**
 * Shared core for the worker and the remember tool: load existing profile,
 * read the delta since the watermark, summarize incrementally, save, advance
 * the watermark. Returns 0 processed when there is nothing new.
 */
export async function summarizeProfileForScope(scope: ProfileScope): Promise<{
  processed: number;
  watermark: Date | null;
}> {
  const existing = await loadProfileData(scope);
  const since = existing?.lastProcessedAt ?? new Date(0);
  const delta = await loadProfileDelta(scope, since);
  if (delta.length === 0) return { processed: 0, watermark: existing?.lastProcessedAt ?? null };

  const { sections } = await summarizeProfileDelta({
    model: profileConfig().model,
    existing: existing ?? { sections: EMPTY_PROFILE_SECTIONS, explicitFacts: [] },
    delta,
  });

  const watermark = new Date(delta[delta.length - 1]!.createdAt);
  await saveProfileResult(scope, { sections, watermark });
  return { processed: delta.length, watermark };
}

export type ProfileDto = {
  sections: ProfileSections;
  explicitFacts: ExplicitFact[];
  updatedAt: string;
};

export async function getProfilingSettingsPayload(userId: string): Promise<{
  user: ProfileDto | null;
  projects: Array<{ id: string; name: string; profile: ProfileDto | null }>;
}> {
  const [userRow, projectRows, projectProfileRows] = await Promise.all([
    prisma.userProfile.findUnique({
      where: { userId },
      select: { sections: true, explicitFacts: true, updatedAt: true },
    }),
    prisma.project.findMany({
      where: { userId },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.projectProfile.findMany({
      where: { userId },
      select: { projectId: true, sections: true, explicitFacts: true, updatedAt: true },
    }),
  ]);

  const byProject = new Map(projectProfileRows.map((row) => [row.projectId, row]));
  return {
    user: userRow
      ? {
          ...toProfileData(userRow),
          updatedAt: userRow.updatedAt.toISOString(),
        }
      : null,
    projects: projectRows.map((project) => {
      const row = byProject.get(project.id);
      return {
        id: project.id,
        name: project.name,
        profile: row
          ? {
              ...toProfileData(row),
              updatedAt: row.updatedAt.toISOString(),
            }
          : null,
      };
    }),
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter api build
```

Expected: 0 errors. If Prisma's Json types reject `sections: {} as Prisma.InputJsonValue`, keep the explicit casts as written.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/profiling/service.ts
git commit -m "feat: add profiling service with watermark delta and summarizer core"
```

---

### Task 4: Profiling queue — bounded debounce + coalesce

**Files:**
- Create: `apps/api/src/modules/profiling/queue.ts`

**Interfaces:**
- Consumes: `getBullmqConnectionOptions`, `getRedis` (`../../lib/redis.js`), `profileConfig` (Task 3), `ProfileScope` (`@assingment/agent`).
- Produces (consumed by Tasks 5, 7, 8):
  - `PROFILE_QUEUE = "profile-summary"`
  - `type ProfileRefreshJobData = { kind: "user" | "project"; userId: string; projectId?: string | null; firstRequestedAt: string }`
  - `profileJobId(scope): string`
  - `getProfileQueue(): Queue<ProfileRefreshJobData>`
  - `enqueueProfileRefresh(scope): Promise<void>` — bounded coalesce
  - `rescheduleProfileRefresh(scope): Promise<void>` — remove pending + fresh window (tool path)
  - `removePendingProfileJob(scope): Promise<void>`
  - `setNeedsProfileRefresh(scope): Promise<void>` / `takeNeedsProfileRefresh(scope): Promise<boolean>`
  - `waitForActiveProfileJob(scope, ttlMs?): Promise<void>`
  - `profileDelayMs(): number`

- [ ] **Step 1: Write the file**

```ts
import { Queue, QueueEvents, type Job } from "bullmq";
import { getBullmqConnectionOptions, getRedis } from "../../lib/redis.js";
import { profileConfig } from "./service.js";
import type { ProfileScope } from "@assingment/agent";

export const PROFILE_QUEUE = "profile-summary";

export type ProfileRefreshJobData = {
  kind: "user" | "project";
  userId: string;
  projectId?: string | null;
  /** ISO timestamp of the first chat that opened the current debounce window. */
  firstRequestedAt: string;
};

export function profileDelayMs(): number {
  return profileConfig().delayMs;
}

export function profileJobId(scope: ProfileScope): string {
  return scope.kind === "user"
    ? `profile:user:${scope.userId}`
    : `profile:project:${scope.projectId}`;
}

let queue: Queue<ProfileRefreshJobData> | null = null;

export function getProfileQueue(): Queue<ProfileRefreshJobData> {
  if (!queue) {
    queue = new Queue<ProfileRefreshJobData>(PROFILE_QUEUE, {
      connection: getBullmqConnectionOptions(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    });
  }
  return queue;
}

async function getPendingJob(
  scope: ProfileScope,
): Promise<Job<ProfileRefreshJobData> | null> {
  const job = await getProfileQueue().getJob(profileJobId(scope));
  if (!job) return null;
  const state = await job.getState();
  if (state === "waiting" || state === "delayed" || state === "active") return job;
  // failed / completed / unknown → stale, remove and let the caller re-add.
  await job.remove().catch(() => {});
  return null;
}

/**
 * Debounce with a bounded window: the job fires ~DELAY after the FIRST request
 * that opened the window, no matter how much activity follows (no starvation).
 * A job that is already active is left alone; the worker's finally block
 * (needs-refresh flag) guarantees a follow-up run.
 */
export async function enqueueProfileRefresh(scope: ProfileScope): Promise<void> {
  const existing = await getPendingJob(scope);
  const delayMs = profileDelayMs();

  if (existing) {
    const state = await existing.getState();
    if (state === "active") {
      await setNeedsProfileRefresh(scope);
      return;
    }
    const firstRequestedAt = existing.data.firstRequestedAt;
    const firstAt = firstRequestedAt ? Date.parse(firstRequestedAt) : NaN;
    const elapsed = Number.isFinite(firstAt) ? Date.now() - firstAt : delayMs;
    const nextDelay = Math.max(0, delayMs - elapsed);
    await existing.updateData({
      ...existing.data,
      firstRequestedAt: existing.data.firstRequestedAt ?? new Date().toISOString(),
    });
    await existing.changeDelay(nextDelay);
    return;
  }

  await getProfileQueue().add(
    profileJobId(scope),
    {
      kind: scope.kind,
      userId: scope.userId,
      projectId: scope.kind === "project" ? scope.projectId : null,
      firstRequestedAt: new Date().toISOString(),
    },
    { delay: delayMs },
  );
}

/** Tool path: clear any pending window and start a fresh one. */
export async function rescheduleProfileRefresh(scope: ProfileScope): Promise<void> {
  await removePendingProfileJob(scope);
  await getProfileQueue().add(
    profileJobId(scope),
    {
      kind: scope.kind,
      userId: scope.userId,
      projectId: scope.kind === "project" ? scope.projectId : null,
      firstRequestedAt: new Date().toISOString(),
    },
    { delay: profileDelayMs() },
  );
}

export async function removePendingProfileJob(scope: ProfileScope): Promise<void> {
  const job = await getProfileQueue().getJob(profileJobId(scope));
  if (!job) return;
  const state = await job.getState();
  if (state === "waiting" || state === "delayed") {
    await job.remove().catch(() => {});
  }
}

const needsRefreshKey = (scope: ProfileScope) => `profile:needs-refresh:${profileJobId(scope)}`;

export async function setNeedsProfileRefresh(scope: ProfileScope): Promise<void> {
  await getRedis().set(needsRefreshKey(scope), "1", "EX", 86400);
}

/** Atomically read-and-clear the flag. */
export async function takeNeedsProfileRefresh(scope: ProfileScope): Promise<boolean> {
  const redis = getRedis();
  const value = await redis.get(needsRefreshKey(scope));
  if (value === null) return false;
  await redis.del(needsRefreshKey(scope));
  return true;
}

/**
 * Wait for an active job of this scope to finish (used by the remember tool so
 * two writers never race on the same profile row). Resolves on timeout.
 */
export async function waitForActiveProfileJob(
  scope: ProfileScope,
  ttlMs = 30_000,
): Promise<void> {
  const job = await getProfileQueue().getJob(profileJobId(scope));
  if (!job) return;
  const state = await job.getState();
  if (state !== "active") return;

  const events = new QueueEvents(PROFILE_QUEUE, {
    connection: getBullmqConnectionOptions(),
  });
  try {
    await job.waitUntilFinished(events, ttlMs);
  } catch {
    // Timeout or events failure — proceed anyway; reschedule still guarantees consistency.
  } finally {
    await events.close().catch(() => {});
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter api build
```

Expected: 0 errors. Verify BullMQ types accept `existing.updateData(...)` / `existing.changeDelay(nextDelay)` (both exist in 5.81.2).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/profiling/queue.ts
git commit -m "feat: add profile queue with bounded debounce coalescing"
```

---

### Task 5: Profile worker + wiring into worker.ts

**Files:**
- Create: `apps/api/src/modules/profiling/worker.ts`
- Modify: `apps/api/src/worker.ts` (import + instantiate + events)

**Interfaces:**
- Consumes: `PROFILE_QUEUE`, `ProfileRefreshJobData`, `enqueueProfileRefresh`, `takeNeedsProfileRefresh`, `profileJobId` (Task 4); `summarizeProfileForScope`, `loadProfileDelta`, `profileConfig` (Task 3); `ProfileScope` (`@assingment/agent`); `Worker` from `bullmq`.
- Produces: `createProfileWorker(): Worker<ProfileRefreshJobData>` (instantiated in `worker.ts`).

- [ ] **Step 1: Write `worker.ts`**

```ts
import { Worker } from "bullmq";
import type { ProfileScope } from "@assingment/agent";
import {
  PROFILE_QUEUE,
  enqueueProfileRefresh,
  profileJobId,
  takeNeedsProfileRefresh,
  type ProfileRefreshJobData,
} from "./queue.js";
import {
  loadProfileDelta,
  profileConfig,
  summarizeProfileForScope,
} from "./service.js";

function scopeFromJobData(data: ProfileRefreshJobData): ProfileScope {
  return data.kind === "project" && data.projectId
    ? { kind: "project", userId: data.userId, projectId: data.projectId }
    : { kind: "user", userId: data.userId };
}

async function processProfileJob(job: {
  id: string;
  data: ProfileRefreshJobData;
}): Promise<void> {
  const scope = scopeFromJobData(job.data);
  console.log(`[profile] summarize start ${profileJobId(scope)}`);

  const result = await summarizeProfileForScope(scope);
  const processed = result.processed;

  // Always close the loop: a chat that finished while this job was running
  // (or a needs-refresh flag set by enqueue) must guarantee a follow-up run.
  let needsFollowUp = await takeNeedsProfileRefresh(scope);
  if (!needsFollowUp && processed > 0 && result.watermark) {
    const leftover = await loadProfileDelta(scope, result.watermark);
    needsFollowUp = leftover.length > 0;
  }
  if (needsFollowUp) {
    await enqueueProfileRefresh(scope);
  }

  console.log(`[profile] summarize done ${profileJobId(scope)} (${processed})`);
}

export function createProfileWorker(): Worker<ProfileRefreshJobData> {
  return new Worker<ProfileRefreshJobData>(
    PROFILE_QUEUE,
    async (job) => {
      try {
        await processProfileJob(job);
      } catch (error) {
        // Throwing lets BullMQ apply attempts/backoff; on exhaustion the job
        // dies and recovery happens on the next chat enqueue (by design).
        console.error(`[profile] summarize failed ${job.id}`, error);
        throw error;
      }
    },
    {
      connection: {
        host: (process.env.REDIS_URL ?? "redis://127.0.0.1:16379").includes("://")
          ? undefined
          : "127.0.0.1",
        maxRetriesPerRequest: null,
      },
      concurrency: profileConfig().concurrency,
    },
  );
}
```

Note: prefer the existing helper — import `getBullmqConnectionOptions` from `../../lib/redis.js` instead of the inline connection object above:

```ts
import { getBullmqConnectionOptions } from "../../lib/redis.js";
// worker options:
{
  connection: getBullmqConnectionOptions(),
  concurrency: profileConfig().concurrency,
}
```

(Use the helper version; the inline block above is only for illustrating intent.)

- [ ] **Step 2: Wire into `apps/api/src/worker.ts`**

Add imports:

```ts
import { createProfileWorker } from "./modules/profiling/worker.js";
```

After the existing document worker setup (before the final `console.log`), add:

```ts
const profileWorker = createProfileWorker();

profileWorker.on("ready", () => {
  console.log(`[profile] ready on queue profile-summary`);
});

profileWorker.on("completed", (job) => {
  console.log(`[profile] completed ${job.id}`);
});

profileWorker.on("failed", (job, error) => {
  console.error(`[profile] failed ${job?.id}`, error);
});

profileWorker.on("error", (error) => {
  console.error("[profile] worker error", error);
});
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter api build
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/profiling/worker.ts apps/api/src/worker.ts
git commit -m "feat: add profile summary worker with needs-refresh loop"
```

---

### Task 6: `remember_user_profile` tool (packages/agent)

**Files:**
- Create: `packages/agent/src/profiling/profile-tool.ts`
- Modify: `packages/agent/src/index.ts` (export)

**Interfaces:**
- Consumes: `createTool` from `@anvia/core`, `zod`, `PROFILE_SECTION_KEYS`/`ProfileScope` (Task 2).
- Produces: `createRememberUserProfileTool(deps): AnyTool` with deps:
  - `scope: ProfileScope`
  - `waitForActiveJob: () => Promise<void>`
  - `appendFact: (input: { section: string | null; fact: string }) => Promise<void>`
  - `refreshNow: () => Promise<{ processed: number }>`
  - `reschedule: () => Promise<void>`

- [ ] **Step 1: Write `profile-tool.ts`**

```ts
import { createTool, type AnyTool } from "@anvia/core";
import z from "zod";
import { PROFILE_SECTION_KEYS, type ProfileScope } from "./types.js";

export type RememberUserProfileDeps = {
  scope: ProfileScope;
  /** Wait for a running background refresh of this scope before writing. */
  waitForActiveJob: () => Promise<void>;
  /** Persist the fact immediately; never fails the chat run. */
  appendFact: (input: { section: string | null; fact: string }) => Promise<void>;
  /** Incrementally summarize the unprocessed delta of this scope. */
  refreshNow: () => Promise<{ processed: number }>;
  /** Open a fresh debounce window for the background worker. */
  reschedule: () => Promise<void>;
};

export function createRememberUserProfileTool(
  deps: RememberUserProfileDeps,
): AnyTool {
  return createTool({
    name: "remember_user_profile",
    description:
      "Save an explicit fact about the user into their durable profile, immediately. " +
      "Call this ONLY when the user explicitly asks you to remember something about them " +
      "(for example 'remember that I prefer X' or 'remember my name is X'). One fact per call.",
    input: z.object({
      fact: z.string().min(1).max(500),
      section: z.enum(PROFILE_SECTION_KEYS).optional(),
    }),
    execute: async ({ fact, section }) => {
      try {
        await deps.waitForActiveJob();
        await deps.appendFact({ section: section ?? null, fact });
        const { processed } = await deps.refreshNow();
        await deps.reschedule();
        return {
          ok: true,
          remembered: fact,
          processed,
        };
      } catch (error) {
        // Facts are already persisted; the chat's stream-complete tap will
        // still enqueue the background refresh, so nothing is lost.
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: `Could not update profile right now: ${message}`,
        };
      }
    },
  });
}
```

Note: with `exactOptionalPropertyTypes`, `section` from the tool input is `ProfileSectionKey | undefined`; passing `section ?? null` satisfies the non-optional `section: string | null` dep signature.

- [ ] **Step 2: Export from `packages/agent/src/index.ts`**

```ts
export * from "./profiling/profile-tool.js";
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @assingment/agent exec tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/profiling/profile-tool.ts packages/agent/src/index.ts
git commit -m "feat: add remember_user_profile tool"
```

---

### Task 7: Chat router integration — injection, tool, enqueue tap

**Files:**
- Create: `apps/api/src/modules/profiling/tap-profile-refresh.ts`
- Modify: `apps/api/src/modules/chat/router.ts`

**Interfaces:**
- Consumes: `enqueueProfileRefresh` (Task 4), `loadProfileData` + `profileConfig` (Task 3), `createRememberUserProfileTool`, `renderProfileContextText`, `hasProfileContent`, `ProfileScope`, `AgentContextBlock` from `@assingment/agent`; existing `tapStreamComplete` chain in router.ts:380.
- Produces: `tapProfileRefresh<T>(source, ctx: { userId: string; projectId?: string | null }): AsyncGenerator<T>` (always enqueues in `finally`, enabled-gated).

- [ ] **Step 1: Write `tap-profile-refresh.ts`**

```ts
import { enqueueProfileRefresh } from "./queue.js";
import { profileConfig } from "./service.js";

/**
 * AsyncIterable tap: after the stream ends (success or error), schedule the
 * profile refresh for the chat's scope. Never throws to the stream consumer.
 */
export async function* tapProfileRefresh<T>(
  source: AsyncIterable<T>,
  ctx: { userId: string; projectId?: string | null },
): AsyncGenerator<T> {
  try {
    for await (const item of source) {
      yield item;
    }
  } finally {
    if (!profileConfig().enabled) return;
    try {
      await enqueueProfileRefresh({ kind: "user", userId: ctx.userId });
      if (ctx.projectId) {
        await enqueueProfileRefresh({
          kind: "project",
          userId: ctx.userId,
          projectId: ctx.projectId,
        });
      }
    } catch (error) {
      console.error("[profile] enqueue after stream failed", error);
    }
  }
}
```

- [ ] **Step 2: Modify `apps/api/src/modules/chat/router.ts`**

a) Add imports (grouped with the existing `@assingment/agent` import):

```ts
import {
  createRememberUserProfileTool,
  hasProfileContent,
  renderProfileContextText,
  type AgentContextBlock,
} from "@assingment/agent";
```

and near the other module imports:

```ts
import { enqueueProfileRefresh, waitForActiveProfileJob } from "../profiling/queue.js";
import {
  appendExplicitFact,
  loadProfileData,
  profileConfig,
  summarizeProfileForScope,
} from "../profiling/service.js";
import { tapProfileRefresh } from "../profiling/tap-profile-refresh.js";
```

(Remove `AgentContextBlock` from the inline import list if it was not imported before — check line 15 of router.ts; it is NOT currently imported, so keep it in the new group above.)

b) Add the instruction constant next to `PROJECT_WORKSPACE_INSTRUCTION` (router.ts:68):

```ts
/** Personalization policy (Anvia rule: policy in instructions, facts in context). */
const PROFILE_INSTRUCTION = [
  "A user profile may be included in the context.",
  "Use it to personalize tone, format, and recall of the user's preferences.",
  "Never reveal the raw profile content to the user.",
  "If the user explicitly asks you to remember something about them, call the remember_user_profile tool.",
  "Never invent profile facts not present in the context.",
].join("\n");
```

c) In the POST `/` handler, after the existing `projectInstruction` block (router.ts:344, before `createAgent`), add profile loading + tool construction:

```ts
    const profilingEnabled = profileConfig().enabled;

    const profileContext: AgentContextBlock[] = [];
    let profileTool: ReturnType<typeof createRememberUserProfileTool> | undefined;

    if (profilingEnabled) {
      const userProfile = await loadProfileData({ kind: "user", userId: user.id });
      if (userProfile && hasProfileContent(userProfile)) {
        profileContext.push({
          id: "user_profile",
          text: renderProfileContextText(userProfile, "User profile"),
        });
      }

      if (projectId) {
        const projectProfile = await loadProfileData({
          kind: "project",
          userId: user.id,
          projectId,
        });
        if (projectProfile && hasProfileContent(projectProfile)) {
          profileContext.push({
            id: "project_profile",
            text: renderProfileContextText(projectProfile, "Project profile"),
          });
        }
      }

      const profileScope: ProfileScope = projectId
        ? { kind: "project", userId: user.id, projectId }
        : { kind: "user", userId: user.id };

      profileTool = createRememberUserProfileTool({
        scope: profileScope,
        waitForActiveJob: () => waitForActiveProfileJob(profileScope),
        appendFact: (input) =>
          appendExplicitFact(profileScope, {
            section: input.section as ProfileSectionKey | null,
            fact: input.fact,
          }),
        refreshNow: () => summarizeProfileForScope(profileScope),
        reschedule: () => rescheduleProfileRefresh(profileScope),
      });
    }
```

(Import `rescheduleProfileRefresh` from the queue module too, and `type ProfileScope` + `type ProfileSectionKey` from `@assingment/agent` in the grouped import.)

d) Pass into `createAgent`:

```ts
      additionalInstructions: [
        catalogInstruction,
        ...(projectInstruction ? [projectInstruction] : []),
        ...(profilingEnabled ? [PROFILE_INSTRUCTION] : []),
      ],
      additionalContext: [
        ...(projectContext ? [projectContext] : []),
        ...profileContext,
      ],
      additionalTools: [
        ...createDataAnalysisTools(),
        ...documentTools,
        ...(profileTool ? [profileTool] : []),
      ],
```

e) Wrap the stream (keep the existing tap order; profile tap outermost so it runs last):

```ts
    const tracedStream = tapProfileRefresh(
      tapStreamComplete(auditedStream, () =>
        finalizeAssistantCitations(sessionId, user.id),
      ),
      { userId: user.id, projectId },
    );
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter api build
```

Expected: 0 errors. Watch for unused imports (e.g., `AgentContextBlock` if the router already imports it — check and dedupe).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/profiling/tap-profile-refresh.ts apps/api/src/modules/chat/router.ts
git commit -m "feat: inject user profiles into chat agent and enqueue refresh after stream"
```

---

### Task 8: Profiling API router + mount

**Files:**
- Create: `apps/api/src/modules/profiling/router.ts`
- Modify: `apps/api/src/index.ts` (mount)

**Interfaces:**
- Consumes: `requireUser` + `AuthVariables` (`../auth/middleware.js`), `getProfilingSettingsPayload`, `resetProfile` (Task 3), `removePendingProfileJob` (Task 4), `prisma` (`../../utils/prisma.js`), `ProfileScope` (`@assingment/agent`).
- Produces: Hono router mounted at `/api/profiling`:
  - `GET /` → settings payload
  - `DELETE /?scope=user` → reset global profile
  - `DELETE /projects/:projectId` → reset project profile (404 `PROJECT_NOT_FOUND` on missing/membership)

- [ ] **Step 1: Write `router.ts`**

```ts
import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { prisma } from "../../utils/prisma.js";
import { removePendingProfileJob } from "./queue.js";
import { getProfilingSettingsPayload, resetProfile } from "./service.js";

export const profilingRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    const user = c.get("user");
    const payload = await getProfilingSettingsPayload(user.id);
    return c.json(payload);
  })
  .delete("/", async (c) => {
    const user = c.get("user");
    const scopeRaw = c.req.query("scope");
    if (scopeRaw !== "user") {
      return c.json({ error: 'scope must be "user"' }, 400);
    }
    await resetProfile({ kind: "user", userId: user.id });
    await removePendingProfileJob({ kind: "user", userId: user.id });
    return c.json({ ok: true });
  })
  .delete("/projects/:projectId", async (c) => {
    const user = c.get("user");
    const projectId = c.req.param("projectId");

    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: user.id },
      select: { id: true },
    });
    if (!project) {
      return c.json({ error: "Project not found", code: "PROJECT_NOT_FOUND" }, 404);
    }

    await resetProfile({ kind: "project", userId: user.id, projectId });
    await removePendingProfileJob({ kind: "project", userId: user.id, projectId });
    return c.json({ ok: true });
  });
```

- [ ] **Step 2: Mount in `apps/api/src/index.ts`**

```ts
import { profilingRouter } from "./modules/profiling/router.js";
// ...
.route("/api/profiling", profilingRouter)
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter api build
```

Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/profiling/router.ts apps/api/src/index.ts
git commit -m "feat: add profiling settings endpoints"
```

---

### Task 9: Environment + README

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Append to `.env.example`**

```env
# User profiling (personalization)
PROFILE_ENABLED=true
PROFILE_REFRESH_DELAY_MINUTES=15
PROFILE_WORKER_CONCURRENCY=3
PROFILE_SUMMARY_MODEL=gpt-5.6-luna
```

- [ ] **Step 2: Update README env table + feature note**

In the env table (after the R2 block or the API block), add rows:

```markdown
| `PROFILE_ENABLED` | Master toggle for user profiling (default `true`) |
| `PROFILE_REFRESH_DELAY_MINUTES` | Debounce window for background profile refresh (default `15`) |
| `PROFILE_WORKER_CONCURRENCY` | Parallel profile summary workers (default `3`) |
| `PROFILE_SUMMARY_MODEL` | Summarizer model; defaults to the chat default (`gpt-5.6-luna`) |
```

Add a short section after "Agent tools (data analysis)":

```markdown
## User profiling

- Per-user (all chats) and per-project profiles are summarized in the background
  (BullMQ `profile-summary` queue) from user messages only — tool calls and
  assistant replies are excluded.
- Profiles are injected into every chat as context blocks (`user_profile`,
  `project_profile`); policy lives in agent instructions.
- The agent can persist explicit facts immediately via `remember_user_profile`
  when the user says "remember…".
- View/reset profiles in Settings → Personalization (`GET`/`DELETE /api/profiling`).
- Failed summary jobs are not retried forever: after `attempts: 3` the job dies
  and the next chat re-opens a refresh window (watermark-derived delta keeps
  nothing lost).
```

- [ ] **Step 3: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document user profiling config"
```

---

### Task 10: Platform API client (apps/platform)

**Files:**
- Modify: `apps/platform/src/lib/api.ts` (append near the projects section)

**Interfaces:**
- Produces:
  - `type ProfileSectionKey`, `type ProfileSections`, `type ExplicitFact`, `type ProfileDto = { sections: ProfileSections; explicitFacts: ExplicitFact[]; updatedAt: string }`
  - `type ProfilingPayload = { user: ProfileDto | null; projects: Array<{ id: string; name: string; profile: ProfileDto | null }> }`
  - `getProfiling(): Promise<ProfilingPayload>`
  - `resetUserProfile(): Promise<{ ok: true }>`
  - `resetProjectProfile(projectId: string): Promise<{ ok: true }>`

- [ ] **Step 1: Append to `apps/platform/src/lib/api.ts`**

```ts
// ─── Profiling (personalization) ────────────────────────────────────────────

export type ProfileSectionKey =
  | "facts"
  | "preferences"
  | "interests"
  | "expertise"
  | "goals";

export type ProfileSections = Record<ProfileSectionKey, string[]>;

export type ExplicitFact = {
  section: ProfileSectionKey | null;
  fact: string;
  createdAt: string;
};

export type ProfileDto = {
  sections: ProfileSections;
  explicitFacts: ExplicitFact[];
  updatedAt: string;
};

export type ProfilingPayload = {
  user: ProfileDto | null;
  projects: Array<{ id: string; name: string; profile: ProfileDto | null }>;
};

export async function getProfiling(): Promise<ProfilingPayload> {
  const response = await apiFetch(`${API_BASE}/api/profiling`);
  if (!response.ok) throw new Error("Failed to load profiles");
  return (await response.json()) as ProfilingPayload;
}

export async function resetUserProfile(): Promise<{ ok: true }> {
  const response = await apiFetch(`${API_BASE}/api/profiling?scope=user`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error("Failed to reset profile");
  return (await response.json()) as { ok: true };
}

export async function resetProjectProfile(
  projectId: string,
): Promise<{ ok: true }> {
  const response = await apiFetch(
    `${API_BASE}/api/profiling/projects/${encodeURIComponent(projectId)}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error("Failed to reset project profile");
  return (await response.json()) as { ok: true };
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter platform exec tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add apps/platform/src/lib/api.ts
git commit -m "feat: add profiling API client"
```

---

### Task 11: Settings UI — Personalization section

**Files:**
- Create: `apps/platform/src/hooks/use-profile.ts`
- Create: `apps/platform/src/components/settings/personalization-section.tsx`
- Modify: `apps/platform/src/components/settings/settings-modal.tsx`

**Interfaces:**
- Consumes: `getProfiling`, `resetUserProfile`, `resetProjectProfile`, `ProfilingPayload` (`#/lib/api`), `Button` (`#/components/ui/button`), `ConfirmDialog` (`#/components/ui/confirm-dialog`).
- Produces: `useProfilePersonalization(active: boolean)` hook + `<PersonalizationSection ... />` component.

- [ ] **Step 1: Write `src/hooks/use-profile.ts`**

```ts
import { useCallback, useEffect, useState } from "react";
import {
  getProfiling,
  resetProjectProfile,
  resetUserProfile,
  type ProfilingPayload,
} from "#/lib/api";

/** Load profiling payload while `active`; expose reset actions. */
export function useProfilePersonalization(active: boolean) {
  const [data, setData] = useState<ProfilingPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const payload = await getProfiling();
      setData(payload);
      setError(null);
    } catch {
      setError("Could not load profiles");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const payload = await getProfiling();
        if (!cancelled) setData(payload);
      } catch {
        if (!cancelled) setError("Could not load profiles");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  const resetUser = useCallback(async () => {
    setResetting("user");
    try {
      await resetUserProfile();
      await reload();
    } catch {
      setError("Could not reset profile");
    } finally {
      setResetting(null);
    }
  }, [reload]);

  const resetProject = useCallback(
    async (projectId: string) => {
      setResetting(`project:${projectId}`);
      try {
        await resetProjectProfile(projectId);
        await reload();
      } catch {
        setError("Could not reset project profile");
      } finally {
        setResetting(null);
      }
    },
    [reload],
  );

  return { data, loading, error, resetting, resetUser, resetProject };
}
```

- [ ] **Step 2: Write `src/components/settings/personalization-section.tsx`**

```tsx
import { useState } from "react";
import { RotateCcw, Sparkles } from "lucide-react";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import type {
  ExplicitFact,
  ProfileDto,
  ProfileSectionKey,
} from "#/lib/api";

const SECTION_LABELS: Record<ProfileSectionKey, string> = {
  facts: "Facts",
  preferences: "Preferences",
  interests: "Interests",
  expertise: "Expertise",
  goals: "Goals",
};

function formatRelativeTime(iso: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(iso)) / 1000),
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ProfileBody({ profile }: { profile: ProfileDto }) {
  const sectionEntries = (Object.keys(SECTION_LABELS) as ProfileSectionKey[])
    .map((key) => ({ key, label: SECTION_LABELS[key], items: profile.sections[key] }))
    .filter((entry) => entry.items.length > 0);

  if (sectionEntries.length === 0 && profile.explicitFacts.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-text-faint">
        No profile yet. It builds automatically from your chats.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {sectionEntries.map((entry) => (
        <div key={entry.key} className="flex flex-col gap-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
            {entry.label}
          </p>
          <ul className="flex flex-col gap-1">
            {entry.items.map((item, index) => (
              <li key={index} className="text-xs leading-relaxed text-text-muted">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {profile.explicitFacts.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
            Remembered
          </p>
          <ul className="flex flex-col gap-1">
            {profile.explicitFacts.map((fact: ExplicitFact, index: number) => (
              <li key={index} className="text-xs leading-relaxed text-text">
                {fact.fact}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export type PersonalizationSectionProps = {
  data: {
    user: ProfileDto | null;
    projects: Array<{ id: string; name: string; profile: ProfileDto | null }>;
  } | null;
  loading: boolean;
  error: string | null;
  resetting: string | null;
  onResetUser: () => void;
  onResetProject: (projectId: string) => void;
};

export function PersonalizationSection({
  data,
  loading,
  error,
  resetting,
  onResetUser,
  onResetProject,
}: PersonalizationSectionProps) {
  const [confirmTarget, setConfirmTarget] = useState<
    { kind: "user" } | { kind: "project"; projectId: string; name: string } | null
  >(null);

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div>
        <h3 className="text-sm font-medium text-text">Personalization</h3>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">
          What the assistant knows about you, built automatically from your
          chats. Reset anytime to start fresh.
        </p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          <div className="skeleton-shimmer h-24 w-full rounded-xl" />
          <div className="skeleton-shimmer h-20 w-full rounded-xl" />
        </div>
      ) : error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : data ? (
        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-3 rounded-xl border border-hairline bg-white/[0.02] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-text-muted" strokeWidth={1.75} />
                <h4 className="text-sm font-medium text-text">Global profile</h4>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmTarget({ kind: "user" })}
                disabled={resetting === "user"}
              >
                <RotateCcw className="size-3.5" strokeWidth={1.75} />
                {resetting === "user" ? "Resetting…" : "Reset"}
              </Button>
            </div>
            {data.user ? (
              <>
                <ProfileBody profile={data.user} />
                <p className="text-[11px] text-text-faint">
                  Updated {formatRelativeTime(data.user.updatedAt)}
                </p>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-text-faint">
                No profile yet. It builds automatically from your chats.
              </p>
            )}
          </section>

          {data.projects.length > 0 ? (
            <div className="flex flex-col gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
                Projects
              </p>
              {data.projects.map((project) => (
                <section
                  key={project.id}
                  className="flex flex-col gap-3 rounded-xl border border-hairline bg-white/[0.02] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h4 className="text-sm font-medium text-text">{project.name}</h4>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setConfirmTarget({
                          kind: "project",
                          projectId: project.id,
                          name: project.name,
                        })
                      }
                      disabled={resetting === `project:${project.id}`}
                    >
                      <RotateCcw className="size-3.5" strokeWidth={1.75} />
                      {resetting === `project:${project.id}` ? "Resetting…" : "Reset"}
                    </Button>
                  </div>
                  {project.profile ? (
                    <ProfileBody profile={project.profile} />
                  ) : (
                    <p className="text-xs leading-relaxed text-text-faint">
                      No profile yet for this project.
                    </p>
                  )}
                </section>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmTarget !== null}
        title="Reset profile?"
        description={
          confirmTarget?.kind === "project"
            ? `This clears the profile for "${confirmTarget.name}" and starts it over from your next chats.`
            : "This clears your global profile and starts it over from your next chats."
        }
        confirmLabel="Reset"
        onConfirm={() => {
          if (!confirmTarget) return;
          if (confirmTarget.kind === "user") {
            onResetUser();
          } else {
            onResetProject(confirmTarget.projectId);
          }
          setConfirmTarget(null);
        }}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}
```

- [ ] **Step 3: Wire into `settings-modal.tsx`**

a) Imports:

```tsx
import { Sparkles } from "lucide-react";
import { useProfilePersonalization } from "#/hooks/use-profile";
import { PersonalizationSection } from "#/components/settings/personalization-section";
```

b) Type + state:

```tsx
type SettingsSection = "account" | "usage" | "personalization";
```

Inside the component (after the usage state):

```tsx
  const profiles = useProfilePersonalization(
    open && section === "personalization",
  );
```

c) Nav button (after the Usage button):

```tsx
          <SettingsNavButton
            active={section === "personalization"}
            icon={<Sparkles className="size-4" strokeWidth={1.75} />}
            label="Personalization"
            onClick={() => setSection("personalization")}
          />
```

d) Render branch: change `section === "account" ? (...) : (...)` to `section === "account" ? (...) : section === "usage" ? (...) : (<PersonalizationSection data={profiles.data} loading={profiles.loading} error={profiles.error} resetting={profiles.resetting} onResetUser={() => void profiles.resetUser()} onResetProject={(id) => void profiles.resetProject(id)} />)`.

Note: `useProfilePersonalization` returns the promise-returning callbacks; wrap with `void` at the call site as shown.

- [ ] **Step 4: Typecheck + build**

```bash
pnpm --filter platform exec tsc --noEmit
pnpm --filter platform build
```

Expected: 0 errors (build may show only the pre-existing chunk-size advisory).

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/hooks/use-profile.ts apps/platform/src/components/settings
git commit -m "feat: add personalization settings UI for user and project profiles"
```

---

### Task 12: End-to-end verification + smoke

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck/build matrix**

```bash
pnpm --filter api build
pnpm --filter @assingment/agent exec tsc --noEmit
pnpm --filter platform exec tsc --noEmit
pnpm --filter platform build
```

Expected: all 0 errors; no new warnings.

- [ ] **Step 2: Prisma sanity**

```bash
pnpm --filter api db:generate
```

Expected: regeneration succeeds; `apps/api/src/generated/prisma` has `UserProfile`/`ProjectProfile` delegates.

- [ ] **Step 3: Manual smoke (API running: `pnpm dev`)**

For faster iteration, temporarily set `PROFILE_REFRESH_DELAY_MINUTES=1` in the developer's `.env` (user-owned; do not commit):
1. Chat 2-3 messages (standalone) → within ~1 minute, `SELECT * FROM user_profile` shows `sections` JSON with content and `lastProcessedAt` advanced; log shows `[profile] summarize done`.
2. Send "ingat saya suka jawaban ringkas" → immediately `GET /api/profiling` shows the fact under `explicitFacts` (tool path).
3. Open a project chat, send a message → `project_profile` row appears; `GET /api/profiling` lists the project profile.
4. `DELETE /api/profiling?scope=user` → global sections/facts cleared; a chat afterwards still works and rebuilds the profile.
5. `DELETE /api/profiling/projects/:id` → 404 for a project the user does not own.
6. Settings modal → Personalization shows global + project cards; Reset works via confirm dialog.
7. Session memory unaffected: reopen a chat session, history still loads; `AgentMemoryMessage` rows untouched.

- [ ] **Step 4: Final review**

```bash
git status --short
git log --oneline -12
```

Expected: only intended files changed; commits follow the plan's messages.

---

## Self-Review Notes

- Spec coverage: data model (T1), summarizer/zod (T2), delta query + service (T3), queue debounce/coalesce + retry semantics (T4), worker + needs-refresh loop (T5), tool (T6), injection + instructions + tap (T7), endpoints (T8), env/README (T9), API client (T10), settings UI (T11), verification (T12).
- Known edge (documented): a chat completing in the milliseconds between the worker's leftover check and job completion is covered by the chat's own enqueue (it sees no pending job and opens a fresh window).
- The `waitUntilFinished` call in Task 4 resolves on timeout without error — safe for the tool hot path.

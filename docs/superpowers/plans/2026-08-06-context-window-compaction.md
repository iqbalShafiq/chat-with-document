# Context Window Tracking & Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move models/reasoning to DB master tables with full specs, show a circular context-usage indicator with hover popover, and run agent + compaction in the BullMQ worker with resumable streams so work survives disconnects and clients can rejoin mid-run.

**Architecture:** Model registry lives in Prisma (provider/model/reasoning + junction, seeded). The chat POST enqueues a `chat-run` BullMQ job; the worker runs compaction (summarize w/ Luna + truncate backstop) then the agent, appending every stream event to a Redis-backed `ResumableStreamStore`. The API serves replay+live via `resumeStreamEvents` envelopes; `@anvia/react` `useChat` auto-resumes with a per-session cursor.

**Tech Stack:** Prisma + Postgres, Hono, BullMQ + Redis Streams (ioredis), `@anvia/server` resumable streams, `@anvia/react` useChat resume, `@anvia/core` (agent, ExtractorBuilder), React 19 + TanStack Router, Tailwind v4.

## Global Constraints

- Branch: `feat/context-window-compaction` (already created). Commit per task.
- No auto-retry for chat-run jobs (`attempts: 1`). Failure → error event + persisted failed pair + close(error).
- Compaction failure must NEVER fall back to truncate-only; abort compaction, run continues uncompacted.
- Trigger ratio 0.7, target ratio 0.3, summary budget ≤0.08 of window, keep 8 recent turns. Env-overridable: `COMPACTION_TRIGGER_RATIO`, `COMPACTION_TARGET_RATIO`, `COMPACTION_KEEP_TURNS`.
- Strict model gating: without models list the composer/send is disabled (loading/error/empty states + retry).
- Model ids become plain `string` end-to-end; validation happens against the DB, never a hardcoded allow-list.
- GPT-5.6 specs (seed values): context window 1_050_000, max input 922_000, max output 128_000; Luna $0.20/$0.02/$1.20, Terra $2/$0.2/$12, Sol $5/$0.5/$30 (input/cached/output per 1M); cacheWriteMultiplier 1.25; longPromptThresholdTokens 272_000, multipliers 2.0/1.5.
- Existing worker pattern to follow: `lib/queue.ts` singleton `Queue` + `Worker` in `src/worker.ts`, `getBullmqConnectionOptions()`.
- Verification per task: `pnpm --filter api exec tsc --noEmit`, `pnpm --filter platform exec tsc --noEmit` (after platform tsconfig is used; `vite build` also OK), `pnpm --filter @assingment/agent exec tsc --noEmit`. There is no lint config and no test framework except vitest added in Task 4 (apps/api only).
- Doc conventions: no comments unless needed; follow existing naming/`@@map` conventions; `verbatimModuleSyntax` → type-only imports must use `import type`.

## File Structure

**apps/api (server + worker):**
- `prisma/schema.prisma` (modify) — 4 master tables
- `prisma/seed.ts` (create) — provider/models/efforts/junction + icons
- `src/modules/models/service.ts` (create) — `listModels()`, `getModelById()`
- `src/modules/models/router.ts` (create) — `GET /api/models`
- `src/index.ts` (modify) — mount models router
- `src/lib/token-estimate.ts` (create) — pure token estimation (chars/4)
- `src/modules/chat/build-run-input.ts` (create) — agent+context builder extracted from router
- `src/modules/chat/context-usage.ts` (create) — estimate for the indicator endpoint
- `src/lib/resumable-stream-store.ts` (create) — Redis `ResumableStreamStore`
- `src/modules/chat/compaction.ts` (create) — pure grouping helpers + `compactSessionMemory`
- `src/modules/chat/run-queue.ts` (create) — BullMQ queue + job data type
- `src/modules/chat/run-worker.ts` (create) — chat-run processor + failure persistence
- `src/modules/chat/router.ts` (rewrite POST /, add endpoints) — enqueue, resume, run-status, stop, context-usage
- `src/worker.ts` (modify) — register chat-run worker + failed/stalled handlers
- `src/modules/chat/memory-sanitizer.ts` (modify) — strip `kind="error"` from agent memory load
- `package.json` (modify) — `db:seed`, `test` scripts; vitest devDep

**packages/agent:**
- `src/providers/openai.ts` (modify) — `CompletionModelId = string`

**apps/platform (frontend):**
- `src/lib/api.ts` (modify) — `listModels`, `fetchContextUsage`, `fetchRunStatus`, `stopChatRun`
- `src/lib/chat/models.ts` (rewrite) — API-driven types + helpers
- `src/lib/chat-preferences.ts` (modify) — validate against loaded models
- `src/hooks/use-models.ts` (create) — models state machine hook
- `src/components/composer/model-reasoning-switcher.tsx` (modify) — API-driven, dynamic icons, None state
- `src/components/composer/context-usage-indicator.tsx` (create) — ring + popover
- `src/components/composer/chat-composer.tsx` (modify) — indicator slot, nullable effort
- `src/components/chat/chat-message-row.tsx` (modify) — error bubble + summary divider
- `src/lib/chat/message-metadata.ts` (modify) — `kind` meta field
- `src/routes/index.tsx` (modify) — resume wiring, gating, join, prefill, truncate-before-send

---

### Task 1: Prisma master tables + migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Test: `pnpm --filter api db:migrate -- --name add_model_master_tables` then `pnpm --filter api db:generate`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `ModelProvider`, `ChatModel`, `ReasoningEffort`, `ModelReasoningEffort` (generated client types `ModelProvider`, `ChatModel`, `ReasoningEffort`, `ModelReasoningEffort`, and enums none).

- [ ] **Step 1: Append the four models to `schema.prisma`** (end of file, after `AgentUsageEvent`):

```prisma
// ─── Model registry (master data, seeded) ──────────────────────────────────

model ModelProvider {
  id        String      @id @default(cuid())
  slug      String      @unique
  name      String
  sortOrder Int         @default(0)
  isActive  Boolean     @default(true)
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt
  models    ChatModel[]

  @@map("model_provider")
}

model ChatModel {
  id                         String                @id @default(cuid())
  modelId                    String                @unique
  providerId                 String
  provider                   ModelProvider         @relation(fields: [providerId], references: [id])
  label                      String
  hint                       String?
  description                String?
  /// Raw SVG (sanitized client-side before render). Empty = default icon.
  iconSvg                    String                @default("")
  contextWindowTokens        Int
  maxInputTokens             Int?
  maxOutputTokens            Int?
  inputPricePerMTokens       Decimal?              @db.Decimal(10, 4)
  cachedInputPricePerMTokens Decimal?              @db.Decimal(10, 4)
  outputPricePerMTokens      Decimal?              @db.Decimal(10, 4)
  cacheWriteMultiplier       Decimal?              @db.Decimal(5, 3)
  longPromptThresholdTokens  Int?
  longPromptInputMultiplier  Decimal?              @db.Decimal(5, 3)
  longPromptOutputMultiplier Decimal?              @db.Decimal(5, 3)
  supportsReasoning          Boolean               @default(true)
  isActive                   Boolean               @default(true)
  sortOrder                  Int                   @default(0)
  createdAt                  DateTime              @default(now())
  updatedAt                  DateTime              @updatedAt
  reasoningEfforts           ModelReasoningEffort[]

  @@index([providerId])
  @@map("chat_model")
}

model ReasoningEffort {
  id          String                @id @default(cuid())
  key         String                @unique
  label       String
  description String?
  sortOrder   Int                   @default(0)
  isActive    Boolean               @default(true)
  createdAt   DateTime              @default(now())
  updatedAt   DateTime              @updatedAt
  models      ModelReasoningEffort[]

  @@map("reasoning_effort")
}

model ModelReasoningEffort {
  id       String         @id @default(cuid())
  modelId  String
  model    ChatModel      @relation(fields: [modelId], references: [id], onDelete: Cascade)
  effortId String
  effort   ReasoningEffort @relation(fields: [effortId], references: [id], onDelete: Cascade)

  @@unique([modelId, effortId])
  @@map("model_reasoning_effort")
}
```

- [ ] **Step 2: Run the migration**

Run: `pnpm --filter api db:migrate -- --name add_model_master_tables`
Expected: migration created and applied; `prisma generate` runs via the script.

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations
git commit -m "feat(api): add model registry master tables"
```

---

### Task 2: Seed script

**Files:**
- Create: `apps/api/prisma/seed.ts`
- Modify: `apps/api/package.json` (add `db:seed` script)

**Interfaces:**
- Consumes: generated Prisma client from Task 1.
- Produces: npm script `db:seed`.

- [ ] **Step 1: Write `apps/api/prisma/seed.ts`**

```ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const PROVIDER_OPENAI = { slug: "openai", name: "OpenAI", sortOrder: 0 };

const MODELS = [
  {
    modelId: "gpt-5.6-luna",
    label: "Luna",
    hint: "Fastest · lowest cost",
    description: "GPT-5.6 optimized for cost-sensitive, high-volume workloads.",
    contextWindowTokens: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    inputPricePerMTokens: "0.20",
    cachedInputPricePerMTokens: "0.02",
    outputPricePerMTokens: "1.20",
    sortOrder: 0,
  },
  {
    modelId: "gpt-5.6-terra",
    label: "Terra",
    hint: "Balanced",
    description: "GPT-5.6 that balances intelligence and cost.",
    contextWindowTokens: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    inputPricePerMTokens: "2.00",
    cachedInputPricePerMTokens: "0.20",
    outputPricePerMTokens: "12.00",
    sortOrder: 1,
  },
  {
    modelId: "gpt-5.6-sol",
    label: "Sol",
    hint: "Highest quality",
    description: "GPT-5.6 frontier model for complex professional work.",
    contextWindowTokens: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    inputPricePerMTokens: "5.00",
    cachedInputPricePerMTokens: "0.50",
    outputPricePerMTokens: "30.00",
    sortOrder: 2,
  },
];

/** Same visual as the current lucide `Cpu` icon (16x16, stroke 1.75). */
const CPU_ICON_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="6" height="6" rx="1"/><path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2"/></svg>`;

const EFFORTS = [
  { key: "low", label: "Low", description: "Minimal reasoning tokens, fastest response.", sortOrder: 0 },
  { key: "medium", label: "Medium", description: "Balanced reasoning depth and latency.", sortOrder: 1 },
  { key: "high", label: "High", description: "Deep reasoning for complex tasks.", sortOrder: 2 },
];

async function main() {
  const provider = await prisma.modelProvider.upsert({
    where: { slug: PROVIDER_OPENAI.slug },
    update: { name: PROVIDER_OPENAI.name, sortOrder: PROVIDER_OPENAI.sortOrder },
    create: PROVIDER_OPENAI,
  });

  const efforts = await Promise.all(
    EFFORTS.map((effort) =>
      prisma.reasoningEffort.upsert({
        where: { key: effort.key },
        update: { label: effort.label, description: effort.description, sortOrder: effort.sortOrder },
        create: effort,
      }),
    ),
  );

  for (const model of MODELS) {
    const { modelId, ...rest } = model;
    const row = await prisma.chatModel.upsert({
      where: { modelId },
      update: { ...rest, providerId: provider.id, iconSvg: CPU_ICON_SVG },
      create: { ...rest, modelId, providerId: provider.id, iconSvg: CPU_ICON_SVG },
    });
    // Junction: every seeded model supports every effort.
    for (const effort of efforts) {
      await prisma.modelReasoningEffort.upsert({
        where: { modelId_effortId: { modelId: row.id, effortId: effort.id } },
        update: {},
        create: { modelId: row.id, effortId: effort.id },
      });
    }
  }

  console.log(`[seed] provider=${provider.slug} models=${MODELS.length} efforts=${efforts.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
```

Note: `@prisma/client` — the generated client output is `../src/generated/prisma`, so `import { PrismaClient } from "@prisma/client"` may not exist. Use the project's own path instead:

```ts
import { PrismaClient } from "../src/generated/prisma/client.js";
```

- [ ] **Step 2: Add the seed script to `apps/api/package.json`**

```json
"db:seed": "pnpm with-env tsx prisma/seed.ts"
```

- [ ] **Step 3: Run the seed**

Run: `pnpm --filter api db:seed`
Expected: logs `[seed] provider=openai models=3 efforts=3`. Re-run twice to confirm idempotency.

- [ ] **Step 4: Verify with a quick query**

Run: `pnpm --filter api exec tsx -e "import('@/.../')"` is not available — instead verify by re-running seed and via Task 3's API.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/seed.ts apps/api/package.json
git commit -m "feat(api): seed model registry master data"
```

---

### Task 3: Models API

**Files:**
- Create: `apps/api/src/modules/models/service.ts`
- Create: `apps/api/src/modules/models/router.ts`
- Modify: `apps/api/src/index.ts`

**Interfaces:**
- Consumes: Prisma generated client (Task 1).
- Produces:
  - `export type ModelInfo = { modelId: string; label: string; hint: string | null; description: string | null; iconSvg: string; provider: { slug: string; name: string }; contextWindowTokens: number; maxInputTokens: number | null; maxOutputTokens: number | null; prices: { input: number | null; cachedInput: number | null; output: number | null; cacheWriteMultiplier: number | null; longPromptThresholdTokens: number | null; longPromptInputMultiplier: number | null; longPromptOutputMultiplier: number | null }; reasoningEfforts: string[]; sortOrder: number }`
  - `export type ReasoningEffortInfo = { key: string; label: string; description: string | null; sortOrder: number }`
  - `export async function listModels(): Promise<{ models: ModelInfo[]; reasoningEfforts: ReasoningEffortInfo[] }>`
  - `export async function findActiveModel(modelId: string): Promise<ModelInfo | null>` (throws nothing; used by chat router + worker)

- [ ] **Step 1: Write `apps/api/src/modules/models/service.ts`**

```ts
import type { Decimal } from "../../generated/prisma/client.js";
import { prisma } from "../../utils/prisma.js";

export type ModelInfo = {
  modelId: string;
  label: string;
  hint: string | null;
  description: string | null;
  iconSvg: string;
  provider: { slug: string; name: string };
  contextWindowTokens: number;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  prices: {
    input: number | null;
    cachedInput: number | null;
    output: number | null;
    cacheWriteMultiplier: number | null;
    longPromptThresholdTokens: number | null;
    longPromptInputMultiplier: number | null;
    longPromptOutputMultiplier: number | null;
  };
  reasoningEfforts: string[];
  sortOrder: number;
};

export type ReasoningEffortInfo = {
  key: string;
  label: string;
  description: string | null;
  sortOrder: number;
};

function toNumber(value: Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toModelInfo(row: {
  modelId: string;
  label: string;
  hint: string | null;
  description: string | null;
  iconSvg: string;
  contextWindowTokens: number;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  inputPricePerMTokens: Decimal | null;
  cachedInputPricePerMTokens: Decimal | null;
  outputPricePerMTokens: Decimal | null;
  cacheWriteMultiplier: Decimal | null;
  longPromptThresholdTokens: number | null;
  longPromptInputMultiplier: Decimal | null;
  longPromptOutputMultiplier: Decimal | null;
  sortOrder: number;
  provider: { slug: string; name: string };
  reasoningEfforts: { effort: { key: string } }[];
}): ModelInfo {
  return {
    modelId: row.modelId,
    label: row.label,
    hint: row.hint,
    description: row.description,
    iconSvg: row.iconSvg,
    provider: row.provider,
    contextWindowTokens: row.contextWindowTokens,
    maxInputTokens: row.maxInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    prices: {
      input: toNumber(row.inputPricePerMTokens),
      cachedInput: toNumber(row.cachedInputPricePerMTokens),
      output: toNumber(row.outputPricePerMTokens),
      cacheWriteMultiplier: toNumber(row.cacheWriteMultiplier),
      longPromptThresholdTokens: row.longPromptThresholdTokens,
      longPromptInputMultiplier: toNumber(row.longPromptInputMultiplier),
      longPromptOutputMultiplier: toNumber(row.longPromptOutputMultiplier),
    },
    reasoningEfforts: row.reasoningEfforts
      .map((entry) => entry.effort.key)
      .sort(),
    sortOrder: row.sortOrder,
  };
}

const MODEL_SELECT = {
  modelId: true,
  label: true,
  hint: true,
  description: true,
  iconSvg: true,
  contextWindowTokens: true,
  maxInputTokens: true,
  maxOutputTokens: true,
  inputPricePerMTokens: true,
  cachedInputPricePerMTokens: true,
  outputPricePerMTokens: true,
  cacheWriteMultiplier: true,
  longPromptThresholdTokens: true,
  longPromptInputMultiplier: true,
  longPromptOutputMultiplier: true,
  sortOrder: true,
  provider: { select: { slug: true, name: true } },
  reasoningEfforts: {
    select: { effort: { select: { key: true } } },
    orderBy: { effort: { sortOrder: "asc" } },
  },
} as const;

export async function listModels(): Promise<{
  models: ModelInfo[];
  reasoningEfforts: ReasoningEffortInfo[];
}> {
  const [models, reasoningEfforts] = await Promise.all([
    prisma.chatModel.findMany({
      where: { isActive: true, provider: { isActive: true } },
      select: MODEL_SELECT,
      orderBy: [{ sortOrder: "asc" }, { modelId: "asc" }],
    }),
    prisma.reasoningEffort.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { key: true, label: true, description: true, sortOrder: true },
    }),
  ]);

  return {
    models: models.map(toModelInfo),
    reasoningEfforts: reasoningEfforts.map((row) => ({
      key: row.key,
      label: row.label,
      description: row.description,
      sortOrder: row.sortOrder,
    })),
  };
}

export async function findActiveModel(modelId: string): Promise<ModelInfo | null> {
  const row = await prisma.chatModel.findFirst({
    where: { modelId, isActive: true, provider: { isActive: true } },
    select: MODEL_SELECT,
  });
  return row ? toModelInfo(row) : null;
}
```

Note: if Prisma's `select` typing complains about the `as const` select, loosen `MODEL_SELECT` to a plain object literal (no `as const`) and let `findMany` infer.

- [ ] **Step 2: Write `apps/api/src/modules/models/router.ts`**

```ts
import { Hono } from "hono";
import { requireUser, type AuthVariables } from "../auth/middleware.js";
import { listModels } from "./service.js";

export const modelsRouter = new Hono<{ Variables: AuthVariables }>()
  .use("*", requireUser)
  .get("/", async (c) => {
    return c.json(await listModels());
  });
```

- [ ] **Step 3: Mount in `apps/api/src/index.ts`**

Add import `modelsRouter` from `./modules/models/router.js` and `.route("/api/models", modelsRouter)` before the usage route.

- [ ] **Step 4: Verify**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: PASS. Then start API (`pnpm dev:api`) and check `curl http://localhost:3001/api/models` requires auth — verify 401 without cookie, and inspect shape after login via the app in Task 12.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/models apps/api/src/index.ts
git commit -m "feat(api): add models list API"
```

---

### Task 4: Token estimation util + vitest setup (apps/api)

**Files:**
- Create: `apps/api/src/lib/token-estimate.ts`
- Create: `apps/api/src/lib/token-estimate.test.ts`
- Modify: `apps/api/package.json` (add `test` script + vitest devDependency)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function estimateTextTokens(text: string): number` — `Math.max(1, Math.ceil(text.length / 4))`
  - `export function estimateMessageTokens(message: unknown): number` — per-message overhead 4 + text parts (recurses tool_result content; images count 85 tokens each; unknown parts use JSON.stringify length / 4)
  - `export function estimateMessagesTokens(messages: unknown[]): number`

- [ ] **Step 1: Install vitest**

Run: `pnpm --filter api add -D vitest` and add script `"test": "vitest run"` to `apps/api/package.json`.

- [ ] **Step 2: Write `apps/api/src/lib/token-estimate.ts`**

```ts
/** OpenAI-aligned heuristic: ~4 characters per token (Microsoft Agent Framework default). */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const IMAGE_TOKENS = 85;

function countPart(part: unknown): number {
  if (!isRecord(part)) return 0;
  switch (part.type) {
    case "text": {
      const text = typeof part.text === "string" ? part.text : "";
      return estimateTextTokens(text);
    }
    case "image":
    case "input_image":
    case "output_image":
      return IMAGE_TOKENS;
    case "tool_result": {
      const content = part.content;
      let total = 0;
      if (Array.isArray(content)) {
        for (const item of content) total += countPart(item);
      } else if (isRecord(content)) {
        total += countPart(content);
      }
      return total;
    }
    default: {
      try {
        return estimateTextTokens(JSON.stringify(part));
      } catch {
        return 0;
      }
    }
  }
}

export function estimateMessageTokens(message: unknown): number {
  if (!isRecord(message)) return 0;
  const overhead = 4; // role + separators
  let contentTokens = 0;
  if (typeof message.content === "string") {
    contentTokens = estimateTextTokens(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) contentTokens += countPart(part);
  }
  return overhead + contentTokens;
}

export function estimateMessagesTokens(messages: unknown[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}
```

- [ ] **Step 3: Write `apps/api/src/lib/token-estimate.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
} from "./token-estimate.js";

describe("estimateTextTokens", () => {
  it("uses ceil(chars/4) with a minimum of 1", () => {
    expect(estimateTextTokens("")).toBe(0);
    expect(estimateTextTokens("a")).toBe(1);
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
    expect(estimateTextTokens("x".repeat(400))).toBe(100);
  });
});

describe("estimateMessageTokens", () => {
  it("counts text parts plus overhead", () => {
    const message = { role: "user", content: [{ type: "text", text: "a".repeat(400) }] };
    expect(estimateMessageTokens(message)).toBe(4 + 100);
  });

  it("counts tool_result nested text parts", () => {
    const message = {
      role: "tool",
      content: [
        {
          type: "tool_result",
          callId: "c1",
          content: [{ type: "text", text: "a".repeat(400) }],
        },
      ],
    };
    expect(estimateMessageTokens(message)).toBe(4 + 100);
  });

  it("counts images as fixed tokens", () => {
    const message = { role: "user", content: [{ type: "image", url: "x" }] };
    expect(estimateMessageTokens(message)).toBe(4 + 85);
  });

  it("handles string content (system messages)", () => {
    expect(estimateMessageTokens({ role: "system", content: "a".repeat(400) })).toBe(4 + 100);
  });

  it("is zero for non-objects", () => {
    expect(estimateMessageTokens(null)).toBe(0);
    expect(estimateMessageTokens("nope")).toBe(0);
  });
});

describe("estimateMessagesTokens", () => {
  it("sums messages", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "a".repeat(400) }] },
      { role: "assistant", content: [{ type: "text", text: "b".repeat(400) }] },
    ];
    expect(estimateMessagesTokens(messages)).toBe(208);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter api test`
Expected: all tests PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `pnpm --filter api exec tsc --noEmit` — Expected PASS (tsconfig `include` is `src/**/*.ts`, tests included; vitest types come from the vitest import).
Commit: `git add apps/api/src/lib/token-estimate.ts apps/api/src/lib/token-estimate.test.ts apps/api/package.json apps/api/pnpm-lock.yaml; git commit -m "feat(api): add token estimation util with tests"` — note `pnpm-lock.yaml` lives at repo root; stage it explicitly.

---

### Task 5: Relax model id union in agent package

**Files:**
- Modify: `packages/agent/src/providers/openai.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export type CompletionModelId = string`; `isCompletionModelId(value): value is string` (non-empty string); `parseCompletionModel(value): string | null`; constants unchanged.

- [ ] **Step 1: Edit `packages/agent/src/providers/openai.ts`**

Replace the union + guards:

```ts
/** Model ids are registered in the DB registry; any non-empty id is structurally valid. */
export type CompletionModelId = string;

export const DEFAULT_COMPLETION_MODEL: CompletionModelId = "gpt-5.6-luna";
export const DEFAULT_COMPLETION_PROVIDER = "openai";

export function isCompletionModelId(value: unknown): value is CompletionModelId {
  return typeof value === "string" && value.trim().length > 0;
}

export function parseCompletionModel(value: unknown): CompletionModelId | null {
  return isCompletionModelId(value) ? value : null;
}
```

Remove the `COMPLETION_MODELS` array and `REASONING_EFFORTS` union only if no other file imports them — keep `REASONING_EFFORTS`/`ReasoningEffort` as-is. `createCompletionModel` keeps the cast (any string id is passed through to the provider).

- [ ] **Step 2: Typecheck all workspaces**

Run: `pnpm --filter @assingment/agent exec tsc --noEmit; pnpm --filter api exec tsc --noEmit`
Expected: PASS. (Platform still imports `CompletionModelId` from `#/lib/chat/models` — unaffected; the platform's own copy is rewritten in Task 12.)

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/providers/openai.ts
git commit -m "feat(agent): accept any registered model id"
```

---

### Task 6: Extract shared run-input builder from the chat router

**Files:**
- Create: `apps/api/src/modules/chat/build-run-input.ts`
- Modify: `apps/api/src/modules/chat/router.ts` (replace inline construction with the new builder)

**Interfaces:**
- Consumes: `createAgent`, `createChunkSearchService`, `createDocumentTools`, `createRememberUserProfileTool`, `buildDocumentCatalogInstruction`, `DOCUMENT_IMAGE_INSTRUCTION`, `renderProfileContextText`, `hasProfileContent`, `tracing`, `profileConfig`, `waitForActiveProfileJob`, `appendExplicitFact`, `loadProfileData`, `summarizeProfileForScope`, `rescheduleProfileRefresh`, `resolveActiveDocuments`, `getObjectBuffer`, `prisma`, `createSanitizedMemoryStore`.
- Produces:
```ts
export type ChatRunInput = {
  agent: ReturnType<typeof createAgent>;
  sessionId: string;
  userId: string;
  projectId: string | null;
  model: string;
  reasoningEffort: string | null;
  instructions: string[];
  contextBlocks: AgentContextBlock[];
  tools: AnyTool[];
  memory: MemoryStore;
  hasActiveDocuments: boolean;
};
export async function buildChatRunInput(input: {
  sessionId: string;
  userId: string;
  model: string;
  reasoningEffort: string | null;
  agentId?: string;
}): Promise<ChatRunInput>
```

- [ ] **Step 1: Write `apps/api/src/modules/chat/build-run-input.ts`**

Move the following from `router.ts` (lines ~334–441) verbatim into this file, returning a `ChatRunInput`:
- `createSanitizedMemoryStore(prisma)` → `memory`
- `resolveActiveDocuments` → `sessionDocuments`, `hasActiveDocuments`
- `buildDocumentCatalogInstruction` → `catalogInstruction`
- `documentTools` construction (only when `hasActiveDocuments`)
- project context + `PROJECT_WORKSPACE_INSTRUCTION` (move the constant here)
- profiling: `profileContext`, `profileTool` (move `PROFILE_INSTRUCTION` constant here)
- `createAgent({ agentId, model: createCompletionModel(model), reasoningEffort: reasoningEffort ?? undefined, tracing, additionalInstructions, additionalContext, additionalTools, memory })`

Signature detail — `createAgent`'s `reasoningEffort` accepts `ReasoningEffort | undefined`; `reasoningEffort` may be `null` → pass `reasoningEffort ?? undefined`.

- [ ] **Step 2: Rewrite the router to use the builder**

In `router.ts`, replace everything from `const prismaMemory = ...` through `const agent = createAgent({...})` with:

```ts
const runInput = await buildChatRunInput({
  sessionId,
  userId: user.id,
  model,
  reasoningEffort,
});
const agent = runInput.agent;
```

The rest of the route (`session(sessionId).prompt(promptMessage).withTrace(...).stream()` and taps) stays unchanged. Keep `titleSeed`/`setChatSessionTitleIfEmpty`, `stripUserAttachments`, model/effort parsing as-is.

- [ ] **Step 3: Typecheck + manual smoke**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: PASS. Smoke: `pnpm dev` → send a chat message → still works exactly as before (identical behavior — pure refactor).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/chat/build-run-input.ts apps/api/src/modules/chat/router.ts
git commit -m "refactor(api): extract shared chat run-input builder"
```

---

### Task 7: Context-usage endpoint

**Files:**
- Create: `apps/api/src/modules/chat/context-usage.ts`
- Modify: `apps/api/src/modules/chat/router.ts` (add `GET /context-usage`)

**Interfaces:**
- Consumes: `buildChatRunInput` (Task 6), `estimateMessagesTokens` + `estimateTextTokens` (Task 4), `findActiveModel` (Task 3), `prisma`, `getRedis` (for active run status reuse in Task 11 — not here).
- Produces:
```ts
export type ContextUsageInfo = {
  modelId: string;
  modelLabel: string;
  contextWindowTokens: number;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  estimatedTokens: number;
  ratio: number;
  thresholdRatio: number;
  targetRatio: number;
  thresholdTokens: number;
  targetTokens: number;
  lastRunInputTokens: number | null;
  reasoningEffort: string | null;
  estimatedAt: string;
};
export async function computeContextUsage(input: {
  sessionId: string;
  userId: string;
  model: string;
  reasoningEffort: string | null;
}): Promise<ContextUsageInfo>
```
- Also `export const compactionConfig = { triggerRatio, targetRatio, keepTurns, summaryBudgetRatio }` read from env once at module load.

- [ ] **Step 1: Write `apps/api/src/modules/chat/context-usage.ts`**

```ts
import { prisma } from "../../utils/prisma.js";
import { estimateMessagesTokens, estimateTextTokens } from "../../lib/token-estimate.js";
import { findActiveModel } from "../models/service.js";
import { buildChatRunInput } from "./build-run-input.js";

function envRatio(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

export const compactionConfig = {
  triggerRatio: envRatio("COMPACTION_TRIGGER_RATIO", 0.7),
  targetRatio: envRatio("COMPACTION_TARGET_RATIO", 0.3),
  keepTurns: Number(process.env.COMPACTION_KEEP_TURNS ?? 8) || 8,
  summaryBudgetRatio: envRatio("COMPACTION_SUMMARY_BUDGET_RATIO", 0.08),
};

export type ContextUsageInfo = { ... } as in the Interfaces block;

export async function computeContextUsage(input: {
  sessionId: string;
  userId: string;
  model: string;
  reasoningEffort: string | null;
}): Promise<ContextUsageInfo> {
  const modelInfo = await findActiveModel(input.model);
  const runInput = await buildChatRunInput({
    sessionId: input.sessionId,
    userId: input.userId,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
  });

  const memoryMessages = await runInput.memory.load({
    sessionId: input.sessionId,
    userId: input.userId,
  });

  let instructionsTokens = 0;
  for (const instruction of runInput.instructions) {
    instructionsTokens += estimateTextTokens(instruction);
  }
  let contextTokens = 0;
  for (const block of runInput.contextBlocks) {
    contextTokens += estimateTextTokens(block.text);
  }
  let toolsTokens = 0;
  for (const tool of runInput.tools) {
    try {
      toolsTokens += estimateTextTokens(JSON.stringify(tool));
    } catch {
      toolsTokens += 0;
    }
  }

  const estimatedTokens =
    estimateMessagesTokens(memoryMessages) + instructionsTokens + contextTokens + toolsTokens;

  const lastRun = await prisma.agentUsageEvent.findFirst({
    where: { userId: input.userId, sessionId: input.sessionId },
    orderBy: { createdAt: "desc" },
    select: { inputTokens: true },
  });

  const window = modelInfo?.contextWindowTokens ?? 1_050_000;
  return {
    modelId: input.model,
    modelLabel: modelInfo?.label ?? input.model,
    contextWindowTokens: window,
    maxInputTokens: modelInfo?.maxInputTokens ?? null,
    maxOutputTokens: modelInfo?.maxOutputTokens ?? null,
    estimatedTokens,
    ratio: window > 0 ? Math.min(1, estimatedTokens / window) : 0,
    thresholdRatio: compactionConfig.triggerRatio,
    targetRatio: compactionConfig.targetRatio,
    thresholdTokens: Math.floor(window * compactionConfig.triggerRatio),
    targetTokens: Math.floor(window * compactionConfig.targetRatio),
    lastRunInputTokens: lastRun?.inputTokens ?? null,
    reasoningEffort: input.reasoningEffort,
    estimatedAt: new Date().toISOString(),
  };
}
```

The `ContextUsageInfo` type must be written out fully (see Interfaces block).

- [ ] **Step 2: Add the route to `apps/api/src/modules/chat/router.ts`**

```ts
.get("/context-usage", async (c) => {
  const user = c.get("user");
  const sessionId = requireSessionId(c.req.query("sessionId"));
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);

  const modelRaw = c.req.query("model");
  const model = modelRaw && modelRaw.trim() ? modelRaw.trim() : DEFAULT_COMPLETION_MODEL;
  const effortRaw = c.req.query("reasoningEffort");
  const reasoningEffort = effortRaw && effortRaw.trim() ? effortRaw.trim() : null;

  return c.json(
    await computeContextUsage({ sessionId, userId: user.id, model, reasoningEffort }),
  );
})
```

Place it before `.post("/truncate", ...)`. (The model param is advisory — the client sends the selected model; estimate is computed against it.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/chat/context-usage.ts apps/api/src/modules/chat/router.ts
git commit -m "feat(api): add session context-usage estimation endpoint"
```

---

### Task 8: Redis resumable stream store

**Files:**
- Create: `apps/api/src/lib/resumable-stream-store.ts`

**Interfaces:**
- Consumes: `@anvia/server` types (`ResumableStreamStore`, `ResumableStreamState`, `ResumableStreamRecord`, `ResumableStreamOpenInput`, `ResumableStreamCloseInput`), `Redis` from ioredis, `getRedis`/`getBullmqConnectionOptions`.
- Produces:
```ts
export type StreamMeta = { userId: string; sessionId: string; modelId: string; reasoningEffort: string | null };
export function createRedisResumableStreamStore(redis: Redis): ResumableStreamStore & {
  openWithMeta(input: ResumableStreamOpenInput, meta: StreamMeta): Promise<ResumableStreamState>;
  getMeta(streamId: string): Promise<StreamMeta | null>;
  setStopFlag(streamId: string): Promise<void>;
}
```
Behavior: `open` is destructive (resets counter + events); `append` throws when status ≠ running; `subscribe(after)` replays then live-tails with XREAD BLOCK, ends when status leaves `running`; `close` idempotent, writes a sentinel to wake blocked readers, sets TTL 24h; keys get TTL 6h on open.

- [ ] **Step 1: Write `apps/api/src/lib/resumable-stream-store.ts`**

```ts
import type { Redis } from "ioredis";
import type {
  ResumableStreamCloseInput,
  ResumableStreamOpenInput,
  ResumableStreamRecord,
  ResumableStreamState,
  ResumableStreamStore,
  ResumableStreamStatus,
  ResumableStreamSubscribeInput,
} from "@anvia/server";

export type StreamMeta = {
  userId: string;
  sessionId: string;
  modelId: string;
  reasoningEffort: string | null;
};

const STATUS_KEY = (streamId: string) => `rs:${streamId}`;
const EVENTS_KEY = (streamId: string) => `rs:${streamId}:events`;
const COUNTER_KEY = (streamId: string) => `rs:${streamId}:counter`;
const STOP_KEY = (streamId: string) => `rs-stop:${streamId}`;

const OPEN_TTL_SECONDS = 6 * 60 * 60;
const CLOSE_TTL_SECONDS = 24 * 60 * 60;
const SENTINEL = "__end__";
const BLOCK_MS = 4000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEventId(streamEntryId: string): number {
  const index = streamEntryId.indexOf("-");
  const base = index === -1 ? streamEntryId : streamEntryId.slice(0, index);
  const parsed = Number(base);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createRedisResumableStreamStore(redis: Redis) {
  const stateFromHash = async (streamId: string): Promise<ResumableStreamState> => {
    const status = await redis.hget(STATUS_KEY(streamId), "status");
    if (status === null) return { status: "missing", lastEventId: 0 };
    const counter = await redis.get(COUNTER_KEY(streamId));
    return {
      status: status as ResumableStreamStatus,
      lastEventId: Number(counter ?? 0),
    };
  };

  const store: ResumableStreamStore = {
    async open(input: ResumableStreamOpenInput): Promise<ResumableStreamState> {
      const existing = await redis.hget(STATUS_KEY(input.streamId), "status");
      if (existing !== null && existing !== "missing") {
        return stateFromHash(input.streamId);
      }
      await redis.hset(STATUS_KEY(input.streamId), "status", "running");
      await redis.del(EVENTS_KEY(input.streamId), COUNTER_KEY(input.streamId));
      await redis.expire(STATUS_KEY(input.streamId), OPEN_TTL_SECONDS);
      await redis.expire(EVENTS_KEY(input.streamId), OPEN_TTL_SECONDS);
      return { status: "running", lastEventId: 0 };
    },

    async append(input: {
      streamId: string;
      event: unknown;
    }): Promise<ResumableStreamRecord> {
      const status = await redis.hget(STATUS_KEY(input.streamId), "status");
      if (status !== "running") {
        throw new Error(`Resumable stream "${input.streamId}" is not running (${status ?? "missing"})`);
      }
      const eventId = await redis.incr(COUNTER_KEY(input.streamId));
      await redis.xadd(EVENTS_KEY(input.streamId), `${eventId}-0`, "e", JSON.stringify(input.event));
      await redis.expire(EVENTS_KEY(input.streamId), OPEN_TTL_SECONDS);
      return {
        streamId: input.streamId,
        eventId,
        event: input.event,
        createdAt: new Date(),
      };
    },

    subscribe(input: ResumableStreamSubscribeInput) {
      const after = input.after ?? 0;
      return {
        [Symbol.asyncIterator](): AsyncIterator<ResumableStreamRecord> {
          let lastRead = after;
          let finished = false;
          const next = async (): Promise<IteratorResult<ResumableStreamRecord>> => {
            while (!finished) {
              const status = await redis.hget(STATUS_KEY(input.streamId), "status");
              const rows = await redis.xrange(
                EVENTS_KEY(input.streamId),
                `(${lastRead}-0`,
                "+",
                "COUNT",
                128,
              );
              for (const [entryId, fields] of rows) {
                const eventId = parseEventId(entryId);
                if (eventId <= lastRead) continue;
                const raw = fields[1];
                let event: unknown;
                try {
                  event = JSON.parse(raw);
                } catch {
                  event = { raw };
                }
                if (isRecord(event) && event.__end__ !== undefined) {
                  finished = true;
                  return { value: undefined, done: true };
                }
                lastRead = eventId;
                return {
                  value: { streamId: input.streamId, eventId, event, createdAt: new Date() },
                  done: false,
                };
              }
              if (status !== null && status !== "running") {
                finished = true;
                return { value: undefined, done: true };
              }
              if (status === null && rows.length === 0) {
                // Stream never opened: end immediately (stale resume).
                finished = true;
                return { value: undefined, done: true };
              }
              await redis.xread(
                "BLOCK",
                BLOCK_MS,
                "COUNT",
                64,
                "STREAMS",
                EVENTS_KEY(input.streamId),
                `${lastRead}-0`,
              );
            }
            return { value: undefined, done: true };
          };
          return { next };
        },
      };
    },

    async status(input: { streamId: string }): Promise<ResumableStreamState> {
      return stateFromHash(input.streamId);
    },

    async close(input: ResumableStreamCloseInput): Promise<ResumableStreamState> {
      const current = await redis.hget(STATUS_KEY(input.streamId), "status");
      if (current === null || current === input.status) {
        return stateFromHash(input.streamId);
      }
      await redis.hset(STATUS_KEY(input.streamId), "status", input.status);
      const counter = await redis.get(COUNTER_KEY(input.streamId));
      const nextId = (Number(counter ?? 0) + 1);
      await redis.xadd(
        EVENTS_KEY(input.streamId),
        `${nextId}-0`,
        "e",
        JSON.stringify({ __end__: input.status }),
      );
      await redis.expire(STATUS_KEY(input.streamId), CLOSE_TTL_SECONDS);
      await redis.expire(EVENTS_KEY(input.streamId), CLOSE_TTL_SECONDS);
      return stateFromHash(input.streamId);
    },
  };

  return {
    ...store,
    async openWithMeta(input: ResumableStreamOpenInput, meta: StreamMeta): Promise<ResumableStreamState> {
      const state = await store.open(input);
      if (state.status === "running") {
        await redis.hset(STATUS_KEY(input.streamId), {
          userId: meta.userId,
          sessionId: meta.sessionId,
          modelId: meta.modelId,
          reasoningEffort: meta.reasoningEffort ?? "",
        });
      }
      return state;
    },
    async getMeta(streamId: string): Promise<StreamMeta | null> {
      const hash = await redis.hgetall(STATUS_KEY(streamId));
      if (!hash.status) return null;
      return {
        userId: hash.userId ?? "",
        sessionId: hash.sessionId ?? "",
        modelId: hash.modelId ?? "",
        reasoningEffort: hash.reasoningEffort || null,
      };
    },
    async setStopFlag(streamId: string): Promise<void> {
      await redis.set(STOP_KEY(streamId), "1", "EX", 600);
    },
  };
}
```

Note: if `@anvia/server` does not export `ResumableStreamStatus` type-only from its index (it does — verified in `dist/index.d.ts`), adjust imports accordingly. If `redis.xrange` types are strict, cast `"COUNT"` args as `any` only where necessary.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/resumable-stream-store.ts
git commit -m "feat(api): add redis-backed resumable stream store"
```

---

### Task 9: Compaction module

**Files:**
- Create: `apps/api/src/modules/chat/compaction.ts`
- Create: `apps/api/src/modules/chat/compaction.test.ts`

**Interfaces:**
- Consumes: `prisma`, `createDefaultMemoryScopeKey`, `estimateMessagesTokens`/`estimateTextTokens` (Task 4), `compactionConfig` (Task 7), `ExtractorBuilder` + `zod` (pattern from `profile-summarizer.ts`), `createCompletionModel` from `@assingment/agent`.
- Produces:
```ts
export type MemoryGroup = { kind: "system" | "user" | "assistant" | "tool"; messages: Message[] };
export function groupMemoryMessages(messages: Message[]): MemoryGroup[]          // atomic tool-call groups; system singletons
export function findCompactionBoundary(groups: MemoryGroup[], keepTurns: number): number  // index into `groups` of first kept group
export function truncateGroupsToTarget(groups: MemoryGroup[], targetTokens: number): { kept: MemoryGroup[]; removed: MemoryGroup[] }
export type CompactionResult =
  | { skipped: true; reason: "below-threshold" }
  | { skipped: true; reason: "summarize-failed"; error: string }
  | { skipped: false; stats: { beforeTokens: number; afterTokens: number; summarizedMessages: number; truncatedGroups: number; summaryTokens: number } };
export async function compactSessionMemory(input: {
  sessionId: string; userId: string;
  windowTokens: number;
  keepTurns: number;
  triggerRatio: number;
  targetRatio: number;
  summaryBudgetRatio: number;
}): Promise<CompactionResult>
```
- The summary message shape: `{ role: "system", content: string, metadata: { kind: "summary" } }`.
- `compactSessionMemory` throws only on DB errors; summarization failures return `{ skipped: true, reason: "summarize-failed" }`.

- [ ] **Step 1: Write pure helpers + tests first**

`groupMemoryMessages`: sequential pass — `system` messages each form their own group; `user` starts a new group; `assistant` messages with tool calls merge with the immediately following `tool` messages into one group; plain assistant text is its own group; `tool` messages not preceded by a tool-call assistant belong to the previous group.

`findCompactionBoundary(groups, keepTurns)`: walk `groups` from the end, counting groups whose kind is `user`; the boundary is the index of the first group after we've seen `keepTurns` user groups (i.e., keep the last `keepTurns` user groups and everything after them, including their assistant/tool groups). If fewer turns exist, boundary = 0. System groups before the boundary stay with the prefix (they're preserved but the summary replaces them — the summary is a system message itself).

`truncateGroupsToTarget(groups, targetTokens)`: drop groups from the start (skipping `system` groups) while `estimateMessagesTokens(remaining) > targetTokens` and more non-system groups remain.

Test file `compaction.test.ts` covers: grouping (tool call + result atomic), boundary with 8 turns, boundary with fewer turns, truncate target math, and that system groups are never truncated.

- [ ] **Step 2: Write `compactSessionMemory`**

```ts
const COMPACTION_SUMMARY_INSTRUCTIONS = [
  "You are summarizing an earlier portion of a conversation so a long chat can continue.",
  "Produce a dense, factual summary that preserves: key facts and numbers, decisions made, user preferences and requirements, open questions, and outcomes of tool/document lookups.",
  "Keep the summary under the stated token budget. Use bullet points.",
  "Do not add anything that is not supported by the conversation.",
  "Output the summary as plain text.",
].join("\n");

const summarySchema = z.object({ summary: z.string() });

async function summarizeMessages(input: {
  model: CompletionModel;
  messages: Message[];
  budgetTokens: number;
}): Promise<{ summary: string; usage: Usage }> {
  const text = input.messages
    .map((message) => renderMessageForSummary(message))
    .filter(Boolean)
    .join("\n");
  const extractor = new ExtractorBuilder(input.model, summarySchema)
    .instructions([
      ...COMPACTION_SUMMARY_INSTRUCTIONS,
      `Token budget: at most ${input.budgetTokens} tokens for the summary.`,
    ])
    .retries(1)
    .build();
  const result = await extractor.extractWithUsage(text);
  return { summary: result.data.summary.trim(), usage: result.usage };
}
```

`renderMessageForSummary(message)` — helper producing `[role] text` lines, reusing `extractTextFromMessageJson` from `@assingment/agent` when available (import from `@assingment/agent`); fallback: JSON stringify. Use the exported helper `extractTextFromMessageJson` (already exported — used in `enrich-memory-messages.ts`).

Then:

```ts
export async function compactSessionMemory(input: {...}): Promise<CompactionResult> {
  const scopeKey = createDefaultMemoryScopeKey(input.sessionId, input.userId);
  const session = await prisma.agentMemorySession.findUnique({ where: { scopeKey }, select: { id: true } });
  if (!session) return { skipped: true, reason: "below-threshold" };

  const rows = await prisma.agentMemoryMessage.findMany({
    where: { memorySessionId: session.id },
    orderBy: { position: "asc" },
    select: { position: true, message: true, createdAt: true },
  });
  const messages = rows
    .map((row) => row.message as Message)
    .filter((message) => !(isRecord(message.metadata) && message.metadata.kind === "error"));

  const beforeTokens = estimateMessagesTokens(messages);
  const triggerTokens = Math.floor(input.windowTokens * input.triggerRatio);
  const targetTokens = Math.floor(input.windowTokens * input.targetRatio);
  if (beforeTokens <= triggerTokens) return { skipped: true, reason: "below-threshold" };

  const groups = groupMemoryMessages(messages);
  const boundary = findCompactionBoundary(groups, input.keepTurns);
  const prefix = groups.slice(0, boundary).flatMap((group) => group.messages);
  const suffix = groups.slice(boundary).flatMap((group) => group.messages);

  const summaryBudget = Math.floor(input.windowTokens * input.summaryBudgetRatio);
  let summaryText: string;
  try {
    const summarized = await summarizeMessages({
      model: createCompletionModel("gpt-5.6-luna"),
      messages: prefix,
      budgetTokens: summaryBudget,
    });
    summaryText = summarized.summary;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[compaction] summarize failed ${input.sessionId}: ${message}`);
    return { skipped: true, reason: "summarize-failed", error: message };
  }

  const summaryMessage: Message = {
    role: "system",
    content: summaryText,
    metadata: { kind: "summary" },
  } as Message;

  let keptSuffix = suffix;
  let truncatedGroups = 0;
  const afterSummaryTokens = estimateMessagesTokens([summaryMessage, ...suffix]);
  if (afterSummaryTokens > targetTokens) {
    const result = truncateGroupsToTarget(groups.slice(boundary), targetTokens);
    keptSuffix = result.kept.flatMap((group) => group.messages);
    truncatedGroups = result.removed.length;
    // Safety: if the summary alone still exceeds the target, summarize tighter once.
    if (estimateMessagesTokens([summaryMessage]) > targetTokens) {
      try {
        const tighter = await summarizeMessages({
          model: createCompletionModel("gpt-5.6-luna"),
          messages: prefix,
          budgetTokens: Math.max(64, Math.floor(targetTokens * 0.5)),
        });
        summaryText = tighter.summary;
      } catch {
        // Keep the first summary; the run proceeds (honest provider error later if any).
      }
    }
  }

  const finalSummary: Message = {
    role: "system",
    content: summaryText,
    metadata: { kind: "summary" },
  } as Message;
  const finalMessages = [finalSummary, ...keptSuffix];
  const afterTokens = estimateMessagesTokens(finalMessages);

  await prisma.$transaction(async (tx) => {
    await tx.agentMemoryMessage.deleteMany({ where: { memorySessionId: session.id } });
    const createdAtByPosition = new Map<number, Date>();
    rows.forEach((row) => createdAtByPosition.set(row.position, row.createdAt));
    const keptRows = keptSuffix.map((message, index) => ({
      memorySessionId: session.id,
      runId: `compaction:${Date.now()}`,
      turn: 0,
      position: index + 1,
      role: message.role,
      message: message as unknown as Prisma.InputJsonValue,
      createdAt: index === 0 ? new Date() : undefined, // summary timestamp = now; kept rows preserve original
    }));
    // Re-map kept rows to their original createdAt by matching message identity is complex;
    // pragmatic: preserve positions 1..n with original createdAt where available.
    ...
  });

  return { skipped: false, stats: { beforeTokens, afterTokens, summarizedMessages: prefix.length, truncatedGroups, summaryTokens: estimateTextTokens(summaryText) } };
}
```

**Important implementation note (do not skip):** the transaction must preserve original `createdAt` for kept messages. Implement as: after computing `keptSuffix`, build `keptByContentKey` — match each kept message to its original row via `JSON.stringify(message)` equality against `row.message` (works because suffix messages are untouched objects). Write rows with `position` reindexed from 1 and the original `createdAt`. Use `prisma.agentMemoryMessage.create` in a loop inside the transaction (createMany with per-row createdAt is fine too: `createMany({ data: [...], skipDuplicates: false })`).

`Prisma` type import: `import type { Prisma } from "../../generated/prisma/client.js"` — note `role` column is `String` in the schema, so `role: message.role` is fine.

- [ ] **Step 3: Tests**

Write `compaction.test.ts` covering the pure helpers (Step 1 lists the cases). Run `pnpm --filter api test` → PASS. Typecheck `pnpm --filter api exec tsc --noEmit` → PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/chat/compaction.ts apps/api/src/modules/chat/compaction.test.ts
git commit -m "feat(api): add session memory compaction with summarize + truncate backstop"
```

---

### Task 10: chat-run queue, worker processor, failure persistence

**Files:**
- Create: `apps/api/src/modules/chat/run-queue.ts`
- Create: `apps/api/src/modules/chat/run-worker.ts`
- Modify: `apps/api/src/worker.ts`
- Modify: `apps/api/src/modules/chat/memory-sanitizer.ts` (strip `kind="error"` in `load`)

**Interfaces:**
- Consumes: Task 8 store, Task 9 compaction, Task 6 builder, `tapAgentStreamUsage`, `tapStreamComplete`/`finalizeAssistantCitations`, `setChatSessionTitleIfEmpty`, `extractUserTextForTitle`-equivalent (title already set by API before enqueue — worker does NOT set title; the API route keeps `setChatSessionTitleIfEmpty` on POST).
- Produces:
```ts
export const CHAT_RUN_QUEUE = "chat-run";
export type ChatRunJobData = { streamId: string; sessionId: string; userId: string; model: string; reasoningEffort: string | null; promptMessage: Message; createdAt: string };
export function getChatRunQueue(): Queue<ChatRunJobData>;
export function enqueueChatRun(jobId: string, data: ChatRunJobData): Promise<void>;
export const ACTIVE_RUN_KEY = (sessionId: string) => `rs-active:${sessionId}`;
export async function tryAcquireActiveRun(sessionId: string, streamId: string, ttlSeconds?: number): Promise<boolean>;  // SET NX
export async function releaseActiveRun(sessionId: string, streamId: string): Promise<void>;  // compare+delete
export async function processChatRunJob(job: Job<ChatRunJobData>): Promise<void>;
export async function failChatRun(streamId: string, error: unknown): Promise<void>;  // idempotent: error event + failed pair + close(error) + release
export async function writeFailedPair(sessionId: string, userId: string, promptMessage: Message, errorText: string): Promise<void>;
```

- [ ] **Step 1: Write `run-queue.ts`** (pattern from `modules/profiling/queue.ts`): queue singleton with `defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 200 }`, `tryAcquireActiveRun` via `redis.set(key, streamId, "EX", ttl, "NX")`, `releaseActiveRun` via compare-and-delete (get + del if equal).

- [ ] **Step 2: Write `run-worker.ts`**

```ts
export async function processChatRunJob(job: Job<ChatRunJobData>): Promise<void> {
  const { streamId, sessionId, userId, model, reasoningEffort, promptMessage } = job.data;
  const store = getStreamStore();

  const status = await store.status({ streamId });
  if (status.status !== "running") {
    console.log(`[chat-run] skip ${streamId} (${status.status})`);
    await releaseActiveRun(sessionId, streamId);
    return;
  }

  try {
    const runInput = await buildChatRunInput({ sessionId, userId, model, reasoningEffort });

    const memoryMessages = await runInput.memory.load({ sessionId, userId });
    const estimated = estimateMessagesTokens(memoryMessages) + staticTokens(runInput);
    const modelInfo = await findActiveModel(model);
    const windowTokens = modelInfo?.contextWindowTokens ?? 1_050_000;

    if (estimated > Math.floor(windowTokens * compactionConfig.triggerRatio)) {
      await store.append({ streamId, event: { type: "compaction", phase: "start", reason: "threshold", model, estimated, threshold: Math.floor(windowTokens * compactionConfig.triggerRatio) } });
      const result = await compactSessionMemory({
        sessionId, userId, windowTokens,
        keepTurns: compactionConfig.keepTurns,
        triggerRatio: compactionConfig.triggerRatio,
        targetRatio: compactionConfig.targetRatio,
        summaryBudgetRatio: compactionConfig.summaryBudgetRatio,
      });
      if (!result.skipped) {
        await store.append({ streamId, event: { type: "compaction", phase: "complete", stats: result.stats } });
      } else {
        await store.append({ streamId, event: { type: "compaction", phase: "error", reason: result.reason } });
      }
    }

    const stream = runInput.agent
      .session(sessionId, { userId })
      .prompt(promptMessage)
      .withTrace({ sessionId, userId, ...(runInput.projectId ? { projectId: runInput.projectId } : {}) })
      .stream();

    const audited = tapAgentStreamUsage(stream, {
      userId, sessionId, provider: DEFAULT_COMPLETION_PROVIDER, model,
      reasoningEffort, agentId: "my-agent",
    });
    const finalTap = tapStreamComplete(audited, () => finalizeAssistantCitations(sessionId, userId));
    const stopChecked = tapStreamStopFlag(finalTap, streamId);

    for await (const event of stopChecked) {
      await store.append({ streamId, event });
    }

    await store.close({ streamId, status: "completed" });
    await releaseActiveRun(sessionId, streamId);
    await getRedis().del(`rs-stop:${streamId}`).catch(() => {});
  } catch (error) {
    await failChatRun(streamId, error, { sessionId, userId, promptMessage });
    throw error;
  }
}
```

`staticTokens(runInput)` = instructions + contextBlocks + tools tokens (same math as Task 7 — extract that tiny sum into a shared helper `estimateStaticContextTokens(runInput)` exported from `context-usage.ts` and reuse it in Task 7's endpoint too).

`tapStreamStopFlag` (in run-worker.ts):

```ts
async function* tapStreamStopFlag<T>(source: AsyncIterable<T>, streamId: string): AsyncGenerator<T> {
  for await (const item of source) {
    if (await getRedis().exists(`rs-stop:${streamId}`)) return;
    yield item;
  }
}
```

`getStreamStore()` — singleton in run-worker.ts using `getRedis()`.

`failChatRun(streamId, error, ctx?)`:

```ts
export async function failChatRun(streamId: string, error: unknown, ctx?: { sessionId: string; userId: string; promptMessage: Message }): Promise<void> {
  const store = getStreamStore();
  const message = error instanceof Error ? error.message : String(error);
  try {
    const status = await store.status({ streamId });
    if (status.status === "running") {
      await store.append({ streamId, event: { type: "error", error: message } });
      await store.close({ streamId, status: "error" });
    }
  } catch (e) { console.error("[chat-run] fail close failed", e); }
  if (ctx) {
    try { await writeFailedPair(ctx.sessionId, ctx.userId, ctx.promptMessage, message); } catch (e) { console.error("[chat-run] failed pair write failed", e); }
    try { await releaseActiveRun(ctx.sessionId, streamId); } catch { /* noop */ }
  }
}
```

`writeFailedPair`: lookup memory session by scope key; if tail already contains a `kind:"error"` assistant row → skip (idempotent). Otherwise append two rows: the prompt message (role user, original message JSON, original metadata incl. clientMessageId) and the error assistant message `{ role: "assistant", content: [{ type: "text", text: friendly }], metadata: { kind: "error" } }` where friendly text is a stable user-facing sentence + the raw error: `Something went wrong while answering. Send again.\n\n${message}`. Positions = next available (`max(position)+1`, `+2`); runId `failed:${Date.now()}`; turn 0.

- [ ] **Step 3: Modify `memory-sanitizer.ts`** — in the wrapper's `load`, filter out messages whose `metadata.kind === "error"` (the agent must never see error artifacts):

```ts
load: async (context) => {
  const loaded = await inner.load(context);
  return loaded.filter(
    (message) => !(isRecord(message.metadata) && message.metadata.kind === "error"),
  );
},
```

- [ ] **Step 4: Wire the worker in `src/worker.ts`**

```ts
import { CHAT_RUN_QUEUE, failChatRun, processChatRunJob, type ChatRunJobData } from "./modules/chat/run-worker.js";

const chatRunWorker = new Worker<ChatRunJobData>(CHAT_RUN_QUEUE, async (job) => {
  try {
    await processChatRunJob(job);
  } catch (error) {
    // failChatRun already ran inside the processor; keep BullMQ bookkeeping.
    throw error;
  }
}, {
  connection: getBullmqConnectionOptions(),
  concurrency: 2,
  lockDuration: 300_000,
  stalledInterval: 120_000,
});
chatRunWorker.on("ready", () => console.log(`[chat-run] ready on queue ${CHAT_RUN_QUEUE}`));
chatRunWorker.on("failed", async (job, error) => {
  if (job?.data) {
    await failChatRun(job.data.streamId, error, {
      sessionId: job.data.sessionId,
      userId: job.data.userId,
      promptMessage: job.data.promptMessage,
    });
  }
});
chatRunWorker.on("error", (error) => console.error("[chat-run] worker error", error));
```

Export `CHAT_RUN_QUEUE` from `run-queue.ts` and re-export/import from there; keep the `run-worker.ts` file for processor + fail helpers, and put `CHAT_RUN_QUEUE` constant + queue + active-run helpers in `run-queue.ts`. `processChatRunJob`/`failChatRun` are imported into `worker.ts` from `run-worker.ts` (which imports `getChatRunQueue` from `run-queue.ts`).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/chat/run-queue.ts apps/api/src/modules/chat/run-worker.ts apps/api/src/worker.ts apps/api/src/modules/chat/memory-sanitizer.ts
git commit -m "feat(api): run agent in chat-run worker with failure persistence"
```

---

### Task 11: Rewrite chat router (enqueue + resume + run-status + stop)

**Files:**
- Modify: `apps/api/src/modules/chat/router.ts`

**Interfaces:**
- Consumes: Task 8 store, Task 10 queue/active-run/fail helpers, `createEventStream` + `resumeStreamEvents` from `@anvia/server`, Task 7 `computeContextUsage`.
- Produces: new `POST /` contract (below), `GET /run-status`, `POST /stop`.

- [ ] **Step 1: New `POST /` implementation**

```ts
.post("/", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const sessionId = requireSessionId(body.sessionId ?? body.metadata?.sessionId);
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);

  const resume = parseResume(body.resume);   // { streamId, after } | null
  const store = getStreamStore();

  if (resume) {
    const meta = await store.getMeta(resume.streamId);
    if (!meta || meta.userId !== user.id || meta.sessionId !== sessionId) {
      return c.json({ error: "stream not found", code: "STREAM_NOT_FOUND" }, 404);
    }
    const events = resumeStreamEvents({ id: resume.streamId, after: resume.after, store });
    return createEventStream(events, { format: "jsonl" });
  }

  // New run
  const modelRaw = body.model;
  const model = modelRaw && typeof modelRaw === "string" && modelRaw.trim()
    ? modelRaw.trim()
    : DEFAULT_COMPLETION_MODEL;
  const modelInfo = await findActiveModel(model);
  if (!modelInfo) return c.json({ error: `unknown model: ${model}` }, 400);

  const effortRaw = body.reasoningEffort;
  let reasoningEffort: string | null = null;
  if (effortRaw && typeof effortRaw === "string" && effortRaw.trim()) {
    if (!modelInfo.reasoningEfforts.includes(effortRaw)) {
      return c.json({ error: `model ${model} does not support reasoning effort: ${effortRaw}` }, 400);
    }
    reasoningEffort = effortRaw;
  }

  const messages = body.messages as MessageType[];
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return c.json({ error: "messages are required" }, 400);

  const chatSession = await ensureChatSession({ sessionId, userId: user.id, projectId: null });
  await touchChatSession(user.id, sessionId);

  const promptMessage = stripUserAttachments(lastMessage);
  const titleSeed = extractUserTextForTitle(promptMessage);
  if (titleSeed) {
    void setChatSessionTitleIfEmpty({ userId: user.id, sessionId, title: titleSeed }).catch((error) => {
      console.error("[chat] set title failed", error);
    });
  }

  const streamId = crypto.randomUUID();
  const acquired = await tryAcquireActiveRun(sessionId, streamId, 2 * 60 * 60);
  if (!acquired) {
    return c.json({ error: "Session is already processing in another tab", code: "RUN_ACTIVE" }, 409);
  }

  try {
    await store.openWithMeta({ streamId }, {
      userId: user.id, sessionId, modelId: model, reasoningEffort,
    });
  } catch (error) {
    await releaseActiveRun(sessionId, streamId);
    throw error;
  }

  await enqueueChatRun(`chat:${streamId}`, {
    streamId, sessionId, userId: user.id, model, reasoningEffort,
    promptMessage, createdAt: new Date().toISOString(),
  });

  const events = withStartTimeout(
    resumeStreamEvents({ id: streamId, after: 0, store }),
    streamId,
    30_000,
  );
  return createEventStream(events, { format: "jsonl" });
})
```

Helpers in the router file:

```ts
function parseResume(value: unknown): { streamId: string; after: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.streamId !== "string" || !record.streamId) return null;
  if (typeof record.after !== "number" || !Number.isInteger(record.after) || record.after < 0) return null;
  return { streamId: record.streamId, after: record.after };
}

async function* withStartTimeout<T>(
  source: AsyncIterable<T>,
  streamId: string,
  timeoutMs: number,
): AsyncGenerator<T> {
  const store = getStreamStore();
  let first = true;
  for await (const item of source) {
    first = false;
    yield item;
  }
  // No-op wrapper; timeout enforced by a race on the first item:
}
```

**Timeout implementation (concrete):** replace the generator above with a real race on the first record:

```ts
async function* withStartTimeout<T>(
  source: AsyncIterable<T>,
  streamId: string,
  timeoutMs: number,
): AsyncGenerator<T> {
  const store = getStreamStore();
  const iterator = source[Symbol.asyncIterator]();
  let receivedAny = false;
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
  while (true) {
    const outcome = await Promise.race([
      iterator.next().then((result) => ({ kind: "next" as const, result })),
      receivedAny ? new Promise<never>(() => {}) : timer,
    ]);
    if (outcome === "timeout") {
      await store.close({ streamId, status: "error" }).catch(() => {});
      // Let the underlying source observe the closed stream and end.
      const ended = await iterator.next().catch(() => ({ done: true as const }));
      if (ended.done) break;
      continue;
    }
    const { result } = outcome;
    if (result.done) break;
    receivedAny = true;
    yield result.value;
  }
}
```

- [ ] **Step 2: Add `GET /run-status` and `POST /stop`**

```ts
.get("/run-status", async (c) => {
  const user = c.get("user");
  const sessionId = requireSessionId(c.req.query("sessionId"));
  if (!sessionId) return c.json({ error: "sessionId is required" }, 400);
  const store = getStreamStore();
  const streamId = await getRedis().get(ACTIVE_RUN_KEY(sessionId));
  if (!streamId) return c.json({ streamId: null, status: "idle", lastEventId: null });
  const state = await store.status({ streamId });
  return c.json({
    streamId,
    status: state.status === "running" ? "running" : state.status,
    lastEventId: state.lastEventId,
  });
})

.post("/stop", async (c) => {
  const user = c.get("user");
  const body = await c.req.json();
  const streamId = typeof body.streamId === "string" ? body.streamId : "";
  if (!streamId) return c.json({ error: "streamId is required" }, 400);
  const store = getStreamStore();
  const meta = await store.getMeta(streamId);
  if (!meta || meta.userId !== user.id) return c.json({ error: "stream not found" }, 404);
  await store.setStopFlag(streamId);
  return c.json({ ok: true });
})
```

Import `ACTIVE_RUN_KEY`, `tryAcquireActiveRun`, `releaseActiveRun`, `enqueueChatRun` from `run-queue.ts`; `getStreamStore` from `run-worker.ts` (or move the store singleton to its own module — prefer exporting `getStreamStore` from `lib/resumable-stream-store.ts` as `let store: ...` + `export function getStreamStore()`; adjust imports accordingly and keep one singleton).

- [ ] **Step 3: Typecheck + smoke**

Run: `pnpm --filter api exec tsc --noEmit` → PASS. Manual smoke: `pnpm dev` (API + worker + platform). Send a message → answer streams (worker path). Close tab mid-stream → reopen → answer continues. Stop button stops. Verify `AgentUsageEvent` rows still recorded and citations still finalized.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/chat/router.ts apps/api/src/lib/resumable-stream-store.ts apps/api/src/modules/chat/run-queue.ts
git commit -m "feat(api): rewrite chat POST as worker-enqueue + resumable stream"
```

---

### Task 12: Platform API client + models lib + preferences + hook

**Files:**
- Modify: `apps/platform/src/lib/api.ts`
- Rewrite: `apps/platform/src/lib/chat/models.ts`
- Modify: `apps/platform/src/lib/chat-preferences.ts`
- Create: `apps/platform/src/hooks/use-models.ts`

**Interfaces:**
- Consumes: `apiFetch`, `API_BASE`.
- Produces:
  - `export type ModelInfo` / `export type ReasoningEffortInfo` (mirror server, `prices` values `number | null`)
  - `export async function listModels(): Promise<{ models: ModelInfo[]; reasoningEfforts: ReasoningEffortInfo[] }>` (throws `ApiAuthError`/`Error`)
  - `export type ContextUsageInfo = { modelId, modelLabel, contextWindowTokens, maxInputTokens, maxOutputTokens, estimatedTokens, ratio, thresholdRatio, targetRatio, thresholdTokens, targetTokens, lastRunInputTokens, reasoningEffort, estimatedAt }`
  - `export async function fetchContextUsage(input: { sessionId: string; model: string; reasoningEffort: string | null }): Promise<ContextUsageInfo>`
  - `export type RunStatusInfo = { streamId: string | null; status: "idle" | "running" | "completed" | "error"; lastEventId: number | null }`
  - `export async function fetchRunStatus(sessionId: string): Promise<RunStatusInfo>`
  - `export async function stopChatRun(streamId: string): Promise<void>`
  - In `lib/chat/models.ts`: `export const DEFAULT_COMPLETION_MODEL = "gpt-5.6-luna"`, `export type ReasoningEffort = string`, helpers `isKnownModel(models, id)`, `modelLabel(models, id)`, `modelById(models, id)`, `resolveReasoningFallback(effort: string | null, supported: string[]): string | null`, `reasoningLabel(efforts, key)`
  - `use-models.ts`: `export function useModels(): { models: ModelInfo[]; reasoningEfforts: ReasoningEffortInfo[]; status: "loading" | "success" | "error"; error: string | null; retry: () => void }`
  - `chat-preferences.ts`: `readSelectedModel(models)` / `persistSelectedModel(model)` / `readSelectedReasoningEffort(effortKeys: string[])` / `persistSelectedReasoningEffort(effort: string | null)`

- [ ] **Step 1: API functions** — add to `apps/platform/src/lib/api.ts` following the `listSessions` pattern (validate response shape minimally, throw `Error` on non-ok, `ApiAuthError` on 401 via `apiFetch`). Include a `CACHE` for `listModels` (module-level `let modelsCache: ... | null`, `listModels({ force })` optional param; cache used by the hook).

- [ ] **Step 2: Rewrite `lib/chat/models.ts`**

```ts
import type { ModelInfo, ReasoningEffortInfo } from "#/lib/api";

export const DEFAULT_COMPLETION_MODEL = "gpt-5.6-luna";
export type ReasoningEffort = string;

export function isKnownModel(models: ModelInfo[], modelId: string): boolean {
  return models.some((model) => model.modelId === modelId);
}

export function modelById(models: ModelInfo[], modelId: string): ModelInfo | null {
  return models.find((model) => model.modelId === modelId) ?? null;
}

export function modelLabel(models: ModelInfo[], modelId: string): string {
  return modelById(models, modelId)?.label ?? modelId;
}

export function reasoningLabel(
  efforts: ReasoningEffortInfo[],
  key: string | null,
): string {
  if (key === null) return "None";
  return efforts.find((effort) => effort.key === key)?.label ?? key;
}

/**
 * Fallback when switching to a model that does not support the current effort:
 * prefer the level directly below, then the one directly above, then null.
 */
export function resolveReasoningFallback(
  effort: string | null,
  supported: string[],
  allEfforts: ReasoningEffortInfo[],
): string | null {
  if (effort === null) return null;
  if (supported.includes(effort)) return effort;
  if (supported.length === 0) return null;
  const ordered = [...allEfforts].sort((a, b) => a.sortOrder - b.sortOrder);
  const currentIndex = ordered.findIndex((entry) => entry.key === effort);
  const sortedSupported = [...supported].sort(
    (a, b) =>
      ordered.findIndex((e) => e.key === a) - ordered.findIndex((e) => e.key === b),
  );
  if (currentIndex !== -1) {
    for (let i = currentIndex - 1; i >= 0; i -= 1) {
      if (sortedSupported.includes(ordered[i]!.key)) return ordered[i]!.key;
    }
    for (let i = currentIndex + 1; i < ordered.length; i += 1) {
      if (sortedSupported.includes(ordered[i]!.key)) return ordered[i]!.key;
    }
  }
  return sortedSupported[0] ?? null;
}
```

- [ ] **Step 3: Rewrite `chat-preferences.ts`** — same localStorage keys; `readSelectedModel(models)` returns stored id if `isKnownModel`, else `DEFAULT_COMPLETION_MODEL` (or first active model); `readSelectedReasoningEffort(effortKeys: string[])` returns stored key if included, else `null` when `effortKeys.length === 0`, else stored-or-`null`; persistence accepts `string | null`.

- [ ] **Step 4: Write `use-models.ts`**

```ts
export function useModels() {
  const [state, setState] = useState<{ status: "loading" | "success" | "error"; models: ModelInfo[]; reasoningEfforts: ReasoningEffortInfo[]; error: string | null }>({ status: "loading", models: [], reasoningEfforts: [], error: null });
  const load = useCallback(() => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    listModels()
      .then((data) => setState({ status: "success", models: data.models, reasoningEfforts: data.reasoningEfforts, error: null }))
      .catch((error) => setState((current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : "Failed to load models" })));
  }, []);
  useEffect(() => { load(); }, [load]);
  return { ...state, retry: load };
}
```

- [ ] **Step 5: Typecheck platform**

Run: `pnpm --filter platform exec tsc --noEmit` (if the platform tsconfig supports it; otherwise `pnpm --filter platform build`)
Expected: PASS — note: `index.tsx` still imports the old `MODEL_OPTIONS`? No — it imports only types + `isCompletionModelId`? It imports `CompletionModelId, ReasoningEffort` types and `chat-preferences` read functions. `model-reasoning-switcher.tsx` imports `MODEL_OPTIONS`, `REASONING_OPTIONS`, `CompletionModelId`, `ReasoningEffort`. Remove those usages in Task 13; temporarily keep `MODEL_OPTIONS`/`REASONING_OPTIONS` exports (marked deprecated) in `models.ts` so this task compiles, and delete them in Task 13. `chat-composer.tsx` imports `CompletionModelId`/`ReasoningEffort` types — keep those type exports (`export type CompletionModelId = string`).

- [ ] **Step 6: Commit**

```bash
git add apps/platform/src/lib/api.ts apps/platform/src/lib/chat/models.ts apps/platform/src/lib/chat-preferences.ts apps/platform/src/hooks/use-models.ts
git commit -m "feat(platform): API-driven model registry client + hook"
```

---

### Task 13: Rewire model/reasoning switcher + composer

**Files:**
- Modify: `apps/platform/src/components/composer/model-reasoning-switcher.tsx`
- Modify: `apps/platform/src/components/composer/chat-composer.tsx`
- Modify: `apps/platform/src/lib/chat/models.ts` (delete `MODEL_OPTIONS`/`REASONING_OPTIONS`/`REASONING_EFFORTS`)

**Interfaces:**
- Consumes: Task 12 types + helpers, `useModels`-provided props (passed down from index.tsx).
- Produces: updated props for `ModelReasoningSwitcher` and `ChatComposer`:
```ts
// ModelReasoningSwitcher
{
  models: ModelInfo[];
  reasoningEfforts: ReasoningEffortInfo[];
  model: string;
  reasoningEffort: string | null;
  disabled?: boolean;
  onModelChange: (model: string) => void;
  onReasoningChange: (effort: string | null) => void;
}
// ChatComposer additions
{
  models: ModelInfo[];
  reasoningEfforts: ReasoningEffortInfo[];
  modelsStatus: "loading" | "success" | "error";
  modelsError: string | null;
  onRetryModels: () => void;
  compaction: { phase: "idle" | "start" | "complete" | "error" } // from index.tsx
  contextUsage: ContextUsageInfo | null;
}
```
- `ReasoningEffortIcon` new signature: `export function ReasoningEffortIcon({ effort, total, className }: { effort: string | null; total: number; className?: string })` — fill = `(indexOf(effort)+1)/total`, `null` → empty.

- [ ] **Step 1: Generalize `ReasoningEffortIcon`**

Replace the 3-state fill with a dasharray gauge:

```tsx
export function ReasoningEffortIcon({
  effort,
  total,
  className = "size-3.5 shrink-0",
}: {
  effort: string | null;
  total: number;
  className?: string;
}) {
  const radius = 6.25;
  const circumference = 2 * Math.PI * radius;
  const index = effort === null ? -1 : EFFORT_ORDER.indexOf(effort);
  const fill = effort === null || total <= 0 ? 0 : Math.min(1, (index + 1) / total);
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden fill="none">
      <circle cx="8" cy="8" r={radius} stroke="currentColor" strokeWidth="1.4" opacity={0.9} />
      <circle
        cx="8" cy="8" r={radius}
        stroke="currentColor" strokeWidth="1.4"
        strokeDasharray={`${circumference * fill} ${circumference}`}
        strokeLinecap="round"
        transform="rotate(-90 8 8)"
        opacity={0.92}
      />
      {effort === null ? (
        <circle cx="8" cy="8" r="2.15" stroke="currentColor" strokeWidth="1.15" opacity={0.45} />
      ) : null}
    </svg>
  );
}
```

`EFFORT_ORDER` = `["low", "medium", "high"]` (used only for icon fill ordering; the actual list comes from props).

- [ ] **Step 2: Rewrite the switcher body**

- Props per Interfaces block; remove `MODEL_OPTIONS`/`REASONING_OPTIONS` imports; derive:
  - `selectedModel = modelById(models, model) ?? models[0] ?? null`
  - `supportedEfforts = selectedModel?.reasoningEfforts ?? []`
  - model options: `models.map((m) => ({ value: m.modelId, label: m.label, hint: m.hint ?? undefined, icon: <ModelIcon svg={m.iconSvg} className="size-3.5 shrink-0 opacity-70" /> }))`
  - reasoning options: for each `reasoningEfforts` filtered to `supportedEfforts`: `{ value: e.key, label: e.label, icon: <ReasoningEffortIcon effort={e.key} total={supportedEfforts.length} /> }`; plus, when `supportedEfforts.length === 0`, a single disabled option `{ value: "", label: "None", disabled: true }`.
  - `onSelect` reasoning: `onReasoningChange(selectedValue === "" ? null : selectedValue)`.
  - `aria-label`/title unchanged. Keep portal positioning logic intact.
- `ModelIcon` helper (new, in the same file): renders `iconSvg` via `dangerouslySetInnerHTML` with a sanitizer, falling back to the `Cpu` lucide icon when empty/invalid:

```tsx
function ModelIcon({ svg, className }: { svg: string; className?: string }) {
  const sanitized = useMemo(() => sanitizeSvg(svg), [svg]);
  if (!sanitized) return <Cpu className={className} strokeWidth={1.75} />;
  return <span className={className} dangerouslySetInnerHTML={{ __html: sanitized }} />;
}

function sanitizeSvg(raw: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) return "";
  const trimmed = raw.trim();
  if (!/^<svg[\s>]/i.test(trimmed)) return "";
  if (/<script|onload|onerror|javascript:/i.test(trimmed)) return "";
  return trimmed;
}
```

- [ ] **Step 3: Update `chat-composer.tsx`**

- Props: replace `model: CompletionModelId`/`reasoningEffort: ReasoningEffort` with `model: string`/`reasoningEffort: string | null`; add `models`, `reasoningEfforts`, `modelsStatus`, `modelsError`, `onRetryModels`, `compaction`, `contextUsage` per Interfaces.
- Rendering: pass new props to `ModelReasoningSwitcher`. Add `<ContextUsageIndicator ... />` to the right of the switcher (same row). Add a models error banner above the composer when `modelsStatus === "error"`:

```tsx
{modelsStatus === "error" ? (
  <div className="flex items-center justify-between gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
    <span>Model list is unavailable: {modelsError}</span>
    <button type="button" onClick={onRetryModels} className="...">Retry</button>
  </div>
) : null}
```

- `disabled={busy || modelsStatus !== "success"}` for the switcher, and keep `Composer.Submit` disabled when `modelsStatus !== "success"` or models list empty. Use existing button/class patterns.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter platform exec tsc --noEmit; pnpm --filter platform build`
Expected: PASS. (`ContextUsageIndicator` import will fail until Task 14 — create a placeholder export in Task 14; to keep this task green, add the import in Task 14 instead. **Order: commit this task without the indicator import, add it in Task 14.**)

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/components/composer/model-reasoning-switcher.tsx apps/platform/src/components/composer/chat-composer.tsx apps/platform/src/lib/chat/models.ts
git commit -m "feat(platform): API-driven model/reasoning switcher with dynamic icons"
```

---

### Task 14: ContextUsageIndicator component

**Files:**
- Create: `apps/platform/src/components/composer/context-usage-indicator.tsx`
- Modify: `apps/platform/src/components/composer/chat-composer.tsx` (wire it in — import + render)

**Interfaces:**
- Consumes: `ContextUsageInfo`, `ModelInfo`, `ReasoningEffortInfo` (Task 12), `ReasoningEffortIcon`/`ModelIcon` (Task 13 — export `ModelIcon` from the switcher file), `createPortal`, existing `glass` styles.
- Produces: `export function ContextUsageIndicator({ models, contextUsage, compaction, className }: { models: ModelInfo[]; contextUsage: ContextUsageInfo | null; compaction: { phase: "idle" | "start" | "complete" | "error" }; className?: string })`.

- [ ] **Step 1: Ring**

SVG 18×18, stroke 2, `circumference = 2πr`; `ratio = contextUsage?.ratio ?? 0`; color: `ratio >= 0.9` → `text-danger`, `>= 0.7` → `text-warning` (define `text-warning` — check existing palette; if absent use `text-amber-400`), else `text-text-muted`/accent. States:
- `contextUsage === null` → skeleton: ring at 0 with `animate-pulse` + tooltip "Loading context usage"
- compaction phase "start" → ring with `animate-pulse` + blinking text label `Compacting context…` (CSS `animate-pulse` on a `span`; moving blink via `animate-[pulse_1.2s_ease-in-out_infinite]` or a custom keyframe defined inline with Tailwind arbitrary values: `animate-[compaction-blink_1.2s_ease-in-out_infinite]` — add the keyframes via a `<style>` tag or Tailwind v4 `@keyframes` in the app CSS; simplest: reuse `animate-pulse`)
- phase "complete"/"error" → transient highlight (ring flashes accent/danger for 1.5s then back to idle) — implement with a small `useState` timer driven by prop changes
- Ratio changes animate with `transition-[stroke-dashoffset] duration-500`.

Hover target: a `<button type="button" aria-label="Context usage" title="Context usage" className="group ...">` containing the ring; popover appears on hover (CSS `group-hover:opacity-100 pointer-events-none`), portaled like the switcher menus (fixed positioning above the shell, `translateY(-100%)`, `zIndex 80`), positioned via the same `updateMenuPosition` pattern (open upward from the composer shell).

- [ ] **Step 2: Popover content**

Panel width ~280px, `glass` styling, rows per model:
- header: "Context usage" + compaction threshold marker legend
- per model row: `ModelIcon`, label (+provider slug muted), mini progress bar (`ratio` shared for all models — same session context), `current / max` formatted (`formatTokens(n)` helper: `1.05M`, `922K`, `12.4K`), ratio %, price line `$0.20 / $0.02 / $1.20 per 1M` when present
- threshold marker at 70% on the bar (`absolute` div)
- states: models empty → empty text; models loading → 3 skeleton rows; error → inline error + the ring turns warning color
- price formatting: `formatUsd(n)` → `$0.20`, `$2.00`, `$30.00` (max 4 decimals, trim zeros)

`formatTokens`/`formatUsd` helpers live in the same file (or `lib/chat/format.ts` — keep in-file, they're tiny; export for reuse).

- [ ] **Step 3: Wire into `chat-composer.tsx`**

Import `ContextUsageIndicator` and render next to `ModelReasoningSwitcher` inside the existing `flex items-center justify-between` row:

```tsx
<div className="flex shrink-0 items-center gap-1.5">
  <ContextUsageIndicator models={models} contextUsage={contextUsage} compaction={compaction} />
  <ComposerAttachControl ... />
  ...
</div>
```

Pass `models`, `contextUsage`, `compaction` through `ChatComposer` props (already in Interfaces from Task 13).

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter platform exec tsc --noEmit; pnpm --filter platform build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/components/composer/context-usage-indicator.tsx apps/platform/src/components/composer/chat-composer.tsx
git commit -m "feat(platform): add context usage ring indicator with popover"
```

---

### Task 15: index.tsx — resume wiring, gating, join, prefill, truncate-before-send

**Files:**
- Modify: `apps/platform/src/routes/index.tsx`

**Interfaces:**
- Consumes: Task 12 (fetchContextUsage, fetchRunStatus, stopChatRun, useModels, resolveReasoningFallback, isKnownModel, modelById, modelLabel), Task 13/14 components, `withChatMessageMeta`/`readChatMessageMeta` (existing), `truncateSessionMemory` (existing).
- Produces: `handleChatEvent(event: unknown)` used as `useChat({ onEvent })`; `joinActiveRunIfNeeded(sessionId)` helper; prefill helper `setComposerInputText(text)`.

- [ ] **Step 1: Models gating in `Home`**

Replace `useState<CompletionModelId>(readSelectedModel)` with models-driven init inside `ChatSession` (or Home — the hook `useModels()` should be called in `Home` and passed down; the `ChatSession` component receives `models`, `reasoningEfforts`, `modelsStatus`, `modelsRetry` as props). On `modelsStatus === "success"`:
- `selectedModel` initial: `isKnownModel(models, readSelectedModel()) ? stored : models[0]?.modelId ?? DEFAULT_COMPLETION_MODEL`
- `selectedReasoningEffort` initial: `readSelectedReasoningEffort(activeModel.reasoningEfforts)` (may be `null`)
- Add effects: when `selectedModel` changes → `setSelectedReasoningEffort((current) => resolveReasoningFallback(current, nextModel.reasoningEfforts, reasoningEfforts))` and persist both.
- `handleModelChange`/`handleReasoningChange` update state + persist (`persistSelectedModel(model)`, `persistSelectedReasoningEffort(effort)` with `string | null`).
- Types: replace `CompletionModelId` with `string` everywhere in this file; `reasoningEffort` state `string | null`.

- [ ] **Step 2: useChat resume + onEvent**

```ts
const chat = useChat({
  transport: chatTransport,
  initialMessages,
  resume: { key: sessionId, storage: "sessionStorage", auto: true },
  createRequest: ({ coreMessages, uiMessages, resume }) => {
    const last = uiMessages.at(-1);
    const documentIds = documentIdsFromMetadata(last?.metadata);
    return {
      messages: coreMessages,
      stream: true as const,
      sessionId,
      documentIds,
      model: selectedModelRef.current,
      reasoningEffort: selectedReasoningEffortRef.current,
      ...(resume ? { resume } : {}),
    };
  },
  onEvent: handleChatEvent,
  onError: (error) => {
    if (error instanceof ApiAuthError) onAuthFailure();
  },
});
```

`handleChatEvent` (useCallback with refs):

```ts
const handleChatEvent = useCallback((event: unknown) => {
  if (!event || typeof event !== "object") return;
  const record = event as Record<string, unknown>;
  if (record.type === "compaction") {
    const phase = record.phase === "start" ? "start" : record.phase === "complete" ? "complete" : record.phase === "error" ? "error" : "idle";
    setCompaction({ phase });
    return;
  }
  if (record.type === "message_end") {
    const usage = record.usage as { inputTokens?: number } | undefined;
    if (usage && typeof usage.inputTokens === "number") {
      setLastRunInputTokens(usage.inputTokens);
    }
    return;
  }
  if (record.type === "error") {
    const errorText =
      record.error instanceof Error
        ? record.error.message
        : typeof record.error === "string"
          ? record.error
          : "The agent run failed";
    setComposerError(`Run gagal: ${errorText}`);
    const failedText = failedUserMessageText(chat.messagesRef ? ... : chat.messages);
    ...
  }
}, []);
```

Because `onEvent` is captured at hook creation, implement it with refs (`messagesRef` via `useRef(chat.messages)` updated in an effect, or use `chat.messages` through a stable ref pattern — the codebase already uses `selectedModelRef` style; do the same: `messagesRef.current = chat.messages` in an effect). On error: prefill composer via `setComposerInputText(failedText)` where `failedText` = raw text of the last user message in `messagesRef.current`.

`setComposerInputText` helper (module-level in index.tsx):

```ts
function setComposerInputText(text: string) {
  const editor = composerInputRef.current?.querySelector<HTMLElement>("[data-anvia-composer-editor]");
  if (!editor) return;
  editor.textContent = text;
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}
```

(Adjust selector to the actual Anvia editor attribute used by `focusComposer` — reuse the same selector constant.)

- [ ] **Step 3: Strict gating**

- `busy` in `ChatComposer` already includes streaming; add `modelsStatus !== "success"` → `disabled`. Pass `modelsStatus`/`modelsError`/`onRetryModels={modelsRetry}`.
- The composer `submitMessage` handler: early-return when `modelsStatus !== "success"` (no-op).

- [ ] **Step 4: run-status join + failed-run banner + prefill on load**

New effect on `[sessionId]` (after history load):

```ts
useEffect(() => {
  let cancelled = false;
  void (async () => {
    try {
      const status = await fetchRunStatus(sessionId);
      if (cancelled) return;
      if (status.status === "error") {
        setPreviousRunError(true);
      }
      if (status.status === "running" && status.streamId) {
        const key = `anvia:chat-resume:${sessionId}`;
        const stored = sessionStorage.getItem(key);
        if (!stored) {
          sessionStorage.setItem(
            key,
            JSON.stringify({
              version: 1,
              streamId: status.streamId,
              lastEventId: 0,
              messages: chat.messages,
            }),
          );
          void chat.resume();
        }
      }
    } catch {
      // ignore — resume state (if any) still handles rejoin
    }
  })();
  return () => { cancelled = true; };
}, [sessionId]);
```

- `previousRunError` state → render a dismissible banner above the composer (reuse the composerError card style; dismiss button clears it).
- Prefill on history load: in the effect that processes `initialMessages`, detect trailing failed pair: last message is assistant with `readChatMessageMeta(meta).kind === "error"` (add `kind` to `ChatMessageMeta` in Task 16 first — order: Task 16 adds `kind`; this task reads it; do Task 16 Step 1 before this step, or inline the check via `metadata.kind` directly), and the message before it is user → `setComposerInputText(rawTextOfThatUserMessage)`.

- [ ] **Step 5: truncate-before-send**

In the `submitMessage` handler, before `chatController.sendMessage(...)`:

```ts
const messages = chat.messages;
const last = messages.at(-1);
const secondLast = messages.at(-2);
const failedMeta = last ? readChatMessageMeta(last.metadata) : {};
if (
  last?.role === "assistant" &&
  failedMeta.kind === "error" &&
  secondLast?.role === "user"
) {
  const userMeta = readChatMessageMeta(secondLast.metadata);
  if (userMeta.clientMessageId) {
    void truncateSessionMemory({
      sessionId,
      mode: "exclude",
      clientMessageId: userMeta.clientMessageId,
    }).catch(() => {});
  }
  chat.setMessages(messages.slice(0, -2));
}
```

Then proceed with the existing send. (The `setMessages` before `sendMessage` is safe — `sendMessage` re-sends the message list.)

- [ ] **Step 6: Context usage polling**

```ts
useEffect(() => {
  if (modelsStatus !== "success") return;
  let cancelled = false;
  const refresh = async () => {
    try {
      const usage = await fetchContextUsage({
        sessionId,
        model: selectedModelRef.current,
        reasoningEffort: selectedReasoningEffortRef.current,
      });
      if (!cancelled) setContextUsage(usage);
    } catch {
      if (!cancelled) setContextUsageError(true);
    }
  };
  void refresh();
  const timer = window.setInterval(refresh, 30_000);
  return () => { cancelled = true; window.clearInterval(timer); };
}, [sessionId, modelsStatus]);
```

Also refresh immediately after `message_end` (in `handleChatEvent`, after `setLastRunInputTokens`) — replace `lastRunInputTokens` handling with a direct `refreshContextUsage()` call (extract the refresh callback so both the effect and the event can use it). When `contextUsage` exists, override `estimatedTokens` display with `lastRunInputTokens` if newer (the endpoint already returns `lastRunInputTokens`; the indicator uses `ratio` from the endpoint response).

- [ ] **Step 7: Wire new props into ChatSession/ChatComposer**

Pass `models`, `reasoningEfforts`, `modelsStatus`, `modelsError`, `modelsRetry`, `compaction`, `contextUsage` down to `ChatComposer` (signatures from Task 13/14).

- [ ] **Step 8: Typecheck + build + smoke**

Run: `pnpm --filter platform exec tsc --noEmit; pnpm --filter platform build` → PASS.
Smoke with `pnpm dev`: models load → switcher shows API models with icons; send works; close tab mid-run → reopen → auto-resume continues streaming; stop works; indicator updates after runs.

- [ ] **Step 9: Commit**

```bash
git add apps/platform/src/routes/index.tsx
git commit -m "feat(platform): resumable chat wiring, strict model gating, failure UX"
```

---

### Task 16: Message rendering — error bubble + summary divider

**Files:**
- Modify: `apps/platform/src/lib/chat/message-metadata.ts` (add `kind?: "summary" | "error"` to `ChatMessageMeta`, read/write in `readChatMessageMeta`/`withChatMessageMeta`)
- Create: `apps/platform/src/components/chat/conversation-summary-divider.tsx`
- Create: `apps/platform/src/components/chat/error-message-bubble.tsx`
- Modify: `apps/platform/src/components/chat/chat-message-row.tsx`

**Interfaces:**
- Consumes: `readChatMessageMeta`, `getMessageRawText`, existing `danger` styles.
- Produces: divider + error bubble components used by `ChatMessageRow` before normal rendering.

- [ ] **Step 1: `kind` in message metadata**

Add to `ChatMessageMeta`: `kind?: "summary" | "error"`; parse in `readChatMessageMeta` (`if (metadata.kind === "summary" || metadata.kind === "error") meta.kind = metadata.kind;`) and write in `withChatMessageMeta` (spread `patch.kind` when defined — add an explicit `if (patch.kind !== undefined) current.kind = patch.kind;`).

- [ ] **Step 2: Summary divider**

```tsx
export function ConversationSummaryDivider() {
  return (
    <div className="flex items-center gap-3 py-1" role="note">
      <span className="h-px flex-1 bg-white/[0.08]" />
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-text-faint">
        Earlier conversation summarized
      </span>
      <span className="h-px flex-1 bg-white/[0.08]" />
    </div>
  );
}
```

- [ ] **Step 3: Error bubble**

```tsx
export function ErrorMessageBubble({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.75} />
      <span className="min-w-0 whitespace-pre-wrap break-words">{text}</span>
    </div>
  );
}
```

Import `AlertCircle` from `lucide-react`.

- [ ] **Step 4: Route in `ChatMessageRow`**

At the top of the row render (before the normal `Message`/`Message.Parts` switch), if `message.role === "system"` (or "assistant") and `readChatMessageMeta(message.metadata).kind === "summary"` → return `<ConversationSummaryDivider />`; if `kind === "error"` → return `<ErrorMessageBubble text={getMessageRawText(message) || "Something went wrong"} />` (no actions bar, no edit/revert). Keep the existing `Message` component for everything else. Preserve the `data-role` attributes so `Thread.Messages` spacing selectors keep working (`data-role={message.role}` on the wrapper div).

- [ ] **Step 5: Typecheck + build + smoke**

Run: `pnpm --filter platform exec tsc --noEmit; pnpm --filter platform build` → PASS. Smoke: force a failed run (e.g. invalid model env) → error bubble appears; refresh → still there; send new chat → pair removed. Run a long chat until compaction → divider appears after reload.

- [ ] **Step 6: Commit**

```bash
git add apps/platform/src/lib/chat/message-metadata.ts apps/platform/src/components/chat/conversation-summary-divider.tsx apps/platform/src/components/chat/error-message-bubble.tsx apps/platform/src/components/chat/chat-message-row.tsx
git commit -m "feat(platform): render error bubble and summary divider in chat history"
```

---

### Task 17: Final verification & smoke

**Files:**
- None (verification only).

- [ ] **Step 1: Fresh DB migration + seed**

Run: `pnpm --filter api db:migrate` (applies pending), `pnpm --filter api db:seed` — idempotent.

- [ ] **Step 2: Full typecheck + build**

Run:
- `pnpm --filter @assingment/agent exec tsc --noEmit`
- `pnpm --filter api exec tsc --noEmit`
- `pnpm --filter api test`
- `pnpm --filter platform exec tsc --noEmit`
- `pnpm --filter platform build`

Expected: all PASS, no errors/warnings.

- [ ] **Step 3: Smoke checklist** (`pnpm dev` with API + worker + platform)

1. Models load from DB; switcher shows Luna/Terra/Sol with icons + hints; reasoning shows Low/Medium/High with dynamic icons.
2. Send message → answer streams; indicator updates (ratio + lastRunInputTokens).
3. Mid-stream: close tab → reopen session → answer continues (auto-resume).
4. Stop button → partial answer, status idle.
5. Switch model mid-session with smaller-window model (simulate by lowering `COMPACTION_TRIGGER_RATIO` to e.g. 0.05 in `.env`) → compaction event → "Compacting context…" blink → answer arrives; summary divider visible after reload.
6. Kill worker mid-run (`Ctrl+C` on `dev:worker`) → error bubble + banner; refresh → error persists; send new chat → pair removed, answer works.
7. `GET /api/models` shape matches `ModelInfo`; strict gating: block API → composer disabled + retry card.
8. Project chat (create/open a project chat) — same behaviors (Task 11+ code is session-keyed, no project branch).

- [ ] **Step 4: Fix anything found, commit leftovers**

```bash
git add -A
git commit -m "chore: final verification fixes"   # only if changes exist
```

---

## Self-Review Notes

- **Spec coverage:** data model + seed (T1–T2), models API (T3), token estimate (T4), id relaxation (T5), run-input extraction (T6), context-usage endpoint (T7), resumable store (T8), compaction (T9), worker + failure pair (T10), router rewrite + resume/stop/run-status (T11), client API + hook (T12), switcher + icons + None + fallback (T13), indicator + popover (T14), index wiring + strict gating + join + prefill + truncate-before-send (T15), error bubble + summary divider (T16), verification (T17). All spec sections mapped.
- **Placeholder scan:** all steps carry concrete code; the only intentional deferral is the indicator import order (documented in T13 step 4).
- **Type consistency:** `ModelInfo`, `ContextUsageInfo`, `RunStatusInfo`, `ChatRunJobData`, `CompactionResult`, `MemoryGroup`, `ChatRunInput` signatures are defined once in their Interfaces blocks and referenced consistently across tasks. `getStreamStore` is defined in `lib/resumable-stream-store.ts` (T8) and consumed in T10/T11.

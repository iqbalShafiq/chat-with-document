# Site Builder v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Versioned site iteration (agent-recommended, user-confirmed), panel as a styled card between transcript and composer with history/rollback/rehydrate, and permanent host-served previews.

**Architecture:** A `propose_site_build`/`confirm_site_build` tool pair joins the main agent (registered beside `request_clarification`); the v1 router intent trigger is deleted so all builds enter through the tools. Session→site mapping lives in `sites-index.json`; `site.json` gains a `stableVersion` pointer. Static preview and by-session/rollback endpoints extend the existing sites router. The panel moves into the existing `composerTopSlot` and is restyled with the app's own panel language.

**Tech Stack:** TypeScript, Anvia v1 tools (`createTool`, `createQuestionTool`), BullMQ + Redis, Hono, Zod 4, React 19, Vitest.

## Global Constraints

- Branch `feat/static-site-builder` (v2 stacks on unmerged v1). Never touch `feat/ai-session-titles`.
- Static-only output stays: pure `dist/`, no backend, no DB, no auth changes. Metadata stays file-based (`site.json`, new `sites-index.json`); no Prisma migration.
- Match the existing visual and code style: reuse or extend existing components, logic, helpers, and utils (composerTopSlot, panel language of DeepResearchActivityPanel/clarification-panel, assertSafeSiteId, best-effort warn idiom, vi.hoisted test patterns). Create new files only when reusable and scalable — one responsibility per file, units testable independently.
- Real-LLM verification uses exactly `meta/muse-spark-1.3-contributor` via OpenRouter.
- Every publish/append stays best-effort; a failed site enqueue never fails chat; the tools must never throw into the agent run — return error text instead.
- Tests use repo patterns: `vi.hoisted` mocks, faked BullMQ `Queue`/`Worker`, fake `CompletionModel`, per-file `// @vitest-environment jsdom` for platform DOM tests.
- Do not add comments unless the surrounding file already documents the same behavior.
- Before editing files under `apps/platform`, run the matching TanStack intent guidance command per `apps/platform/AGENTS.md`.
- Pre-flight (node_modules may lag the lockfile): run `pnpm install --frozen-lockfile` once from the repo root before the first task.

---

## File Structure

Create:
- `packages/agent/src/tools/site-build.ts` — propose/confirm tools, definitions, instructions.
- `packages/agent/src/tools/site-build.test.ts`

Modify:
- `packages/agent/src/tools/static-definition.ts` (only if the propose/confirm definitions need the static helper — read it first; web-search.ts:1-7 shows the import shape)
- `packages/agent/src/index.ts` (export new module)
- `apps/api/src/modules/chat/build-run-input.ts:829` (push `SITE_BUILD_TOOL_INSTRUCTIONS` after `CLARIFICATION_INSTRUCTION`), `:878-890` (add `...SITE_BUILD_TOOL_DEFINITIONS` after line 887 `...CLARIFICATION_TOOL_DEFINITIONS`), `:1404` (push `createSiteBuildTools()` beside clarification)
- `apps/api/src/modules/static-sites/service.ts` (sites-index read/write, `stableVersion`, `listSitesBySession`)
- `apps/api/src/modules/static-sites/service.test.ts`
- `apps/api/src/modules/static-sites/download.ts` (static preview + by-session + rollback routes)
- `apps/api/src/modules/static-sites/download.test.ts`
- `apps/api/src/modules/static-sites/worker.ts` (static previewUrl, index write, drop container preview)
- `apps/api/src/modules/static-sites/worker.test.ts`
- `apps/api/src/modules/chat/router.ts` (delete v1 intent trigger block + now-dead imports)
- `apps/platform/src/components/sites/site-build-panel.tsx` (card, VersionList, rollback, rehydrate props)
- `apps/platform/src/components/sites/site-build-panel.test.tsx`
- `apps/platform/src/components/workspace/chat-route-view.tsx` (composerTopSlot wiring, remove below-chat panel)
- `README.md` (v2 behaviors)

Delete nothing else. No new packages. No new env vars (`SITE_*` already exist).

---

### Task 1: Propose/confirm agent tools

**Files:**
- Create: `packages/agent/src/tools/site-build.ts`
- Test: `packages/agent/src/tools/site-build.test.ts`
- Modify: `packages/agent/src/index.ts`

**Interfaces:**
- Consumes: `createTool` from `@anvia/core` (same import as `tools/web-search.ts:1`), `parseSiteBrief` + `isSiteBuilderIntent` from `../sites/site-plan.js`, `buildSiteBuilderPrompt` from `../sites/site-builder-agent.js`, `SITE_BRIEF_JSON_INSTRUCTIONS` + `extractSiteBriefJson` from `../sites/site-plan.js` (added by v1 smoke fixes — read the file first and use exact export names).
- Produces:
  - `SITE_BUILD_TOOL_DEFINITIONS: ToolDefinition[]` (two static definitions, pattern of `CLARIFICATION_TOOL_DEFINITIONS` in `tools/clarification.ts:10-12`)
  - `SITE_BUILD_TOOL_INSTRUCTIONS: string`
  - `createSiteBuildTools(deps: SiteBuildToolDeps): AnyTool[]` with `SiteBuildToolDeps = { parseBrief: typeof parseSiteBrief; readActiveSite: (sessionId: string) => Promise<{ siteId: string; siteName: string } | null>; enqueueBuild: (input: { siteId: string | null; sessionId: string; userId: string; prompt: string; brief: SiteBrief }) => Promise<{ siteId: string; version: number }> }`
  - Tool `propose_site_build` (input `{ prompt: string }`, uses ambient session context for sessionId/userId like sibling tools — read `tools/documents.ts` first for how session/user reach tool execute; mirror exactly): parses brief, reads active site, returns `{ action: "create", brief }` when no active site, `{ action: "create", brief, reason: "different-topic" }` when brief siteName differs case-insensitively from active siteName, else `{ action: "ask", brief, activeSite, question: string, choices: [{ id: "iterate", label }, { id: "new-site", label }], recommendation: "iterate" }`. Never writes, never enqueues, never throws into the run — catches all errors into `{ action: "error", message }`.
  - Tool `confirm_site_build` (input `{ brief: SiteBrief (zod siteBriefSchema), mode: z.enum(["iterate", "new-site"]), activeSiteId: z.string().optional() }`): requires activeSiteId when mode is iterate (throw `new Error("activeSiteId is required to iterate")` otherwise — input validation errors are the tool framework's normal path, not run failures); calls `enqueueBuild({ siteId: mode === "iterate" ? activeSiteId : null, ... })`; returns `{ siteId, version }`.
  - `SITE_BUILD_TOOL_INSTRUCTIONS`: "After propose_site_build returns action ask, call request_clarification with its question and choices verbatim, then call confirm_site_build with the user's pick (iterate → mode iterate + that activeSiteId, new-site → mode new-site). Never enqueue without confirm. Never invent siteIds."

- [ ] **Step 1: Write the failing test**

Create `packages/agent/src/tools/site-build.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import {
  SITE_BUILD_TOOL_DEFINITIONS,
  SITE_BUILD_TOOL_INSTRUCTIONS,
  createSiteBuildTools,
} from "./site-build.js";
import type { SiteBrief } from "../sites/site-plan.js";

const BRIEF: SiteBrief = {
  siteName: "Kopi Senja",
  audience: "pecinta kopi",
  cta: "Pesan",
  sections: ["hero", "kontak"],
  vibe: "hangat",
};

function deps(overrides: Record<string, unknown> = {}) {
  return {
    parseBrief: vi.fn(async () => ({ brief: BRIEF, usage: { inputTokens: 1, outputTokens: 1 } })),
    readActiveSite: vi.fn(async () => null),
    enqueueBuild: vi.fn(async () => ({ siteId: "new-id", version: 1 })),
    ...overrides,
  };
}

async function callTool(tools: { name: string; execute: (input: never, context: unknown) => Promise<unknown> }[], name: string, input: unknown) {
  const tool = tools.find((tool) => tool.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool.execute(input as never, {});
}

describe("propose_site_build", () => {
  it("returns create when no active site exists", async () => {
    const tools = createSiteBuildTools(deps());
    const result = await callTool(tools, "propose_site_build", { prompt: "bikinkan landing kopi" });
    expect(result).toMatchObject({ action: "create", brief: BRIEF });
  });

  it("returns create with different-topic when names differ", async () => {
    const tools = createSiteBuildTools(
      deps({ readActiveSite: vi.fn(async () => ({ siteId: "s-old", siteName: "Toko Roti" })) }),
    );
    const result = await callTool(tools, "propose_site_build", { prompt: "bikinkan landing kopi" });
    expect(result).toMatchObject({ action: "create", reason: "different-topic" });
  });

  it("returns ask with choices and recommendation when names match", async () => {
    const tools = createSiteBuildTools(
      deps({ readActiveSite: vi.fn(async () => ({ siteId: "s-1", siteName: "kopi senja" })) }),
    );
    const result = await callTool(tools, "propose_site_build", { prompt: "ganti headline" });
    expect(result).toMatchObject({
      action: "ask",
      recommendation: "iterate",
      choices: [{ id: "iterate" }, { id: "new-site" }],
    });
  });

  it("returns error instead of throwing when parsing fails", async () => {
    const tools = createSiteBuildTools(
      deps({ parseBrief: vi.fn(async () => { throw new Error("provider down"); }) }),
    );
    const result = await callTool(tools, "propose_site_build", { prompt: "x" });
    expect(result).toMatchObject({ action: "error" });
  });
});

describe("confirm_site_build", () => {
  it("enqueues iterate with the active site id", async () => {
    const enqueueBuild = vi.fn(async () => ({ siteId: "s-1", version: 2 }));
    const tools = createSiteBuildTools(deps({ enqueueBuild }));
    const result = await callTool(tools, "confirm_site_build", {
      brief: BRIEF,
      mode: "iterate",
      activeSiteId: "s-1",
    });
    expect(result).toEqual({ siteId: "s-1", version: 2 });
    expect(enqueueBuild).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: "s-1", prompt: expect.any(String) }),
    );
  });

  it("enqueues new-site with null site id", async () => {
    const enqueueBuild = vi.fn(async () => ({ siteId: "s-2", version: 1 }));
    const tools = createSiteBuildTools(deps({ enqueueBuild }));
    await callTool(tools, "confirm_site_build", { brief: BRIEF, mode: "new-site" });
    expect(enqueueBuild).toHaveBeenCalledWith(expect.objectContaining({ siteId: null }));
  });
});

describe("definitions and instructions", () => {
  it("exposes two static definitions and the clarify-then-confirm rule", () => {
    expect(SITE_BUILD_TOOL_DEFINITIONS.map((definition) => definition.name).sort()).toEqual([
      "confirm_site_build",
      "propose_site_build",
    ]);
    expect(SITE_BUILD_TOOL_INSTRUCTIONS).toContain("request_clarification");
    expect(SITE_BUILD_TOOL_INSTRUCTIONS).toContain("confirm_site_build");
  });
});
```

(If `ToolDefinition` has no `.name` field, read `tools/static-definition.ts` first and assert on the actual shape — `definition.name` vs `definition.function.name` — keeping the two-names assertion exact.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/agent exec vitest run src/tools/site-build.test.ts`
Expected: FAIL — cannot resolve `./site-build.js`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/agent/src/tools/site-build.ts` (mirror `createTool` usage in `tools/web-search.ts`; input schemas via zod with `.describe()` on every field like sibling tools):

```ts
import { createTool, type AnyTool } from "@anvia/core";
import type { ToolDefinition } from "@anvia/core";
import { z } from "zod";
import { parseSiteBrief, siteBriefSchema, type SiteBrief } from "../sites/site-plan.js";
import { createStaticToolDefinition } from "./static-definition.js";

export type SiteBuildProposal =
  | { action: "create"; brief: SiteBrief; reason?: "no-active-site" | "different-topic" }
  | {
      action: "ask";
      brief: SiteBrief;
      activeSite: { siteId: string; siteName: string };
      question: string;
      choices: { id: string; label: string }[];
      recommendation: "iterate";
    }
  | { action: "error"; message: string };

export type SiteBuildToolDeps = {
  parseBrief: typeof parseSiteBrief;
  readActiveSite: (sessionId: string) => Promise<{ siteId: string; siteName: string } | null>;
  enqueueBuild: (input: {
    siteId: string | null;
    sessionId: string;
    userId: string;
    prompt: string;
    brief: SiteBrief;
  }) => Promise<{ siteId: string; version: number }>;
};

const proposeInput = z.object({
  prompt: z.string().min(1).max(2000).describe("The user's site request, verbatim."),
});

const confirmInput = z.object({
  brief: siteBriefSchema.describe("The brief returned by propose_site_build, unchanged."),
  mode: z.enum(["iterate", "new-site"]).describe("iterate adds a version to activeSiteId; new-site starts fresh."),
  activeSiteId: z.string().min(1).max(120).optional().describe("Required when mode is iterate."),
});

export function createSiteBuildTools(deps: SiteBuildToolDeps): AnyTool[] {
  const propose = createTool({
    name: "propose_site_build",
    description:
      "Decide how to handle a static-website request: create fresh or iterate the session's active site. Never builds anything itself.",
    inputSchema: proposeInput,
    execute: async ({ prompt }, context) => {
      const session = context as { sessionId?: string; userId?: string };
      try {
        const { brief } = await deps.parseBrief({
          model: (context as { model?: never }).model as never,
          modelId: "site-build",
          prompt,
        });
        const activeSite = session.sessionId ? await deps.readActiveSite(session.sessionId) : null;
        if (!activeSite) return { action: "create", brief, reason: "no-active-site" } as const;
        if (activeSite.siteName.trim().toLowerCase() !== brief.siteName.trim().toLowerCase()) {
          return { action: "create", brief, reason: "different-topic" } as const;
        }
        return {
          action: "ask",
          brief,
          activeSite,
          question: `Iterate "${activeSite.siteName}" sebagai versi baru, atau mulai situs baru?`,
          choices: [
            { id: "iterate", label: `Iterate ${activeSite.siteName} (versi baru)` },
            { id: "new-site", label: "Mulai situs baru" },
          ],
          recommendation: "iterate",
        } as const;
      } catch (error) {
        return {
          action: "error",
          message: error instanceof Error ? error.message.slice(0, 500) : String(error),
        } as const;
      }
    },
  });

  const confirm = createTool({
    name: "confirm_site_build",
    description: "Enqueue the site build decided via propose_site_build (and clarification when asked).",
    inputSchema: confirmInput,
    execute: async ({ brief, mode, activeSiteId }, context) => {
      const session = context as { sessionId?: string; userId?: string; originalPrompt?: string };
      if (mode === "iterate" && !activeSiteId) {
        throw new Error("activeSiteId is required to iterate");
      }
      return deps.enqueueBuild({
        siteId: mode === "iterate" ? (activeSiteId as string) : null,
        sessionId: session.sessionId ?? "",
        userId: session.userId ?? "",
        prompt: session.originalPrompt ?? brief.siteName,
        brief,
      });
    },
  });

  return [propose, confirm];
}
```

Two integration details the implementer must resolve by reading (not guessing):
- Session/model access inside `execute`: read `tools/documents.ts` first for exactly how `ToolCallContext` carries `sessionId`/`userId`/`model`, and use those exact field paths (adjust the `context as` casts above to the real shape; the test passes `{}` so casts must tolerate it).
- `SITE_BUILD_TOOL_DEFINITIONS`: read `tools/static-definition.ts` + how `CLARIFICATION_TOOL_DEFINITIONS` is built, then export two static definitions with the same helper. `SITE_BUILD_TOOL_INSTRUCTIONS` is the constant string specified in the Interfaces below.

```ts
export const SITE_BUILD_TOOL_INSTRUCTIONS = [
  "You have propose_site_build and confirm_site_build for static-website requests.",
  "Always call propose_site_build first. After it returns action ask, call request_clarification with its question and choices verbatim, then call confirm_site_build with the user's pick (iterate plus that activeSiteId, or new-site).",
  "Never enqueue without confirm. Never invent siteIds.",
].join("\n");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @anreal/agent exec vitest run src/tools/site-build.test.ts`
Expected: PASS (adjust only the context-field casts per what `documents.ts` shows; keep all assertions).

- [ ] **Step 5: Export and run the suite**

In `packages/agent/src/index.ts`, append `export * from "./tools/site-build.js";` (check for symbol clashes first — `SiteBrief` comes from `sites/site-plan.js`, do not re-export it here).

Run: `pnpm --filter @anreal/agent test`
Expected: PASS apart from the parked wrap-tool tsc/file reds (tests only; do not touch those files).

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/tools/site-build.ts packages/agent/src/tools/site-build.test.ts packages/agent/src/index.ts
git commit -m "feat(agent): add propose and confirm site build tools"
```

---

### Task 2: Recipe wiring (instructions + static + runtime tools)

**Files:**
- Modify: `apps/api/src/modules/chat/build-run-input.ts:829` (instructions), `:878-890` (static definitions), `:1404` (runtime tools)
- Test: existing parity/recipe tests (update expectations only as failures dictate)

**Interfaces:**
- Consumes: Task 1 `SITE_BUILD_TOOL_DEFINITIONS`, `SITE_BUILD_TOOL_INSTRUCTIONS`, `createSiteBuildTools`.
- Produces: every chat recipe includes the site tools + instructions; frozen static surface updated; reconstruction path (`resolveChatAgentRecipe` near line 1046: `makeAgent`, line 1146 fragments, line 1404+ tools) builds them with real deps (`parseSiteBrief` + real model, index read from service, enqueue via queue).

- [ ] **Step 1: Register and let the parity tests pinpoint updates**

1a. Add the import beside the clarification import (line 7-12):
```ts
import {
  SITE_BUILD_TOOL_DEFINITIONS,
  SITE_BUILD_TOOL_INSTRUCTIONS,
  createSiteBuildTools,
} from "@anreal/agent";
```
(Verify `@anreal/agent` is already imported in this file — line 10 shows `createAgent` from there; extend that import if the names come from the same barrel, else add a new import line. Check first.)

1b. After line 829 (`instructions.push(CLARIFICATION_INSTRUCTION);`) add:
```ts
instructions.push(SITE_BUILD_TOOL_INSTRUCTIONS);
```

1c. After line 887 (`...CLARIFICATION_TOOL_DEFINITIONS,`) add:
```ts
...SITE_BUILD_TOOL_DEFINITIONS,
```

1d. After line 1404 (`tools.push(createClarificationTool());`) add:
```ts
tools.push(
  ...createSiteBuildTools({
    parseBrief: parseSiteBrief,
    readActiveSite: (sessionId) => readActiveSiteTitle(sessionId),
    enqueueBuild: (input) => enqueueSiteBuildFromTool(input),
  }),
);
```
with imports for `parseSiteBrief` (from `@anreal/agent`), `readActiveSiteTitle` + `enqueueSiteBuildFromTool` — both small functions you create in `apps/api/src/modules/static-sites/service.ts` in THIS task (see 1e): `readActiveSiteTitle(sessionId)` reads `sites-index.json` (returns `{ siteId, siteName } | null`; corrupt/missing index → null with warn), `enqueueSiteBuildFromTool({ siteId, sessionId, userId, prompt, brief })` resolves version (siteId null → version 1 + fresh `crypto.randomUUID()`; else manifest version + 1), writes the `queued` manifest (with brief-derived seed fields per existing `writeSiteManifest` shape), enqueues via `enqueueSiteBuild`, returns `{ siteId, version }`. Both best-effort-safe (throw only on programmer errors, never on missing data — missing data yields null/fresh).

1e. Add unit tests for the two service functions in `apps/api/src/modules/static-sites/service.test.ts` (temp dir via `SITE_DATA_DIR` stub env, existing pattern): index round-trip, corrupt index → null, fresh version 1 + new id, iterate bumps version, manifest written queued.

- [ ] **Step 2: Run the recipe/parity suites and update expectations exactly as failures dictate**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/chat/build-run-input.test.ts src/modules/chat/run-recipe-behavior.test.ts src/modules/chat/image-view-wiring.test.ts`
Expected: FAIL — frozen static surface changed (instructions + tool definitions).
For each failure, update ONLY the expected tool list / instruction fragments / counts to include the two site tools + instruction (mirror how clarification entries appear in those expectations). Do not alter test logic. (Note: `run-recipe-behavior.test.ts:418` is a parked pre-existing failure about researcher middlewares — leave it failing as before; verify it fails identically, not newly.)

- [ ] **Step 3: Run broader chat tests + typecheck**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/chat/ src/modules/static-sites/`
Expected: PASS apart from the 2 parked pre-existing files (deep-research-wiring, run-recipe-behavior:418).

Run: `pnpm --filter @anreal/api exec tsc --noEmit`
Expected: clean (api gate is green at v1 HEAD — keep it so).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/chat/build-run-input.ts apps/api/src/modules/static-sites/service.ts apps/api/src/modules/static-sites/service.test.ts apps/api/src/modules/chat/build-run-input.test.ts apps/api/src/modules/chat/run-recipe-behavior.test.ts apps/api/src/modules/chat/image-view-wiring.test.ts
git commit -m "feat(chat): wire site build tools into agent recipe"
```
(Adjust the test file list to exactly the files failures required touching — stage by exact path after `git status`.)

---

### Task 3: stableVersion + sites-index + trigger removal

**Files:**
- Modify: `apps/api/src/modules/static-sites/service.ts` (`stableVersion` in manifest + index helpers if not done in Task 2 — Task 2 owns them; this task only adds what is missing)
- Modify: `apps/api/src/modules/chat/router.ts` (delete the v1 intent trigger block + now-dead imports `isSiteBuilderIntent`, `enqueueSiteBuild`, `siteBuildConfig`, `writeSiteManifest` IF unused elsewhere in the file — check with grep before deleting each import)
- Test: `apps/api/src/modules/chat/interaction-resume.test.ts` (only if it asserts trigger behavior — read it; v1 plan added no router trigger tests on this branch, so likely untouched)

**Interfaces:**
- Consumes: Task 2 index + manifest.
- Produces: no router-side enqueue path remains; `stableVersion` defaults to latest ready version.

- [ ] **Step 1: Extend manifest + delete trigger**

1a. In `service.ts`, extend `SiteManifest` with `stableVersion: number | null` (null until first ready) and `versions: Record<number, { status: SiteBuildStatus; updatedAt: string }>` (every built version gets an entry; rollback reads readiness from this map). Update `service.test.ts` MANIFEST fixture with `stableVersion: null, versions: { 1: { status: "queued", updatedAt: <fixture date> } }` plus a round-trip case preserving both fields. (Task 4's rollback and Task 5's ready-write build on this exact shape — no later reshaping.)

1b. Delete the intent trigger block in `router.ts` (the `siteBuildConfig().enabled && isSiteBuilderIntent(firstUserText)` try/catch added by v1 Task 9 — read lines ~985-1015 first and delete exactly that block, keeping `touchChatSession` and the `titleSeed` block byte-identical). Remove dead imports only after grepping each name's remaining uses in the file.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/chat/interaction-resume.test.ts src/modules/chat/router.test.ts src/modules/static-sites/`
Expected: PASS (add `site-build` trigger-absence assertion only if the file already asserts trigger presence — it does not on this branch; do not invent new router tests here).
(A `router.test.ts` may not exist — run it only if present; `interaction-resume.test.ts` is the router suite.)

Run: `pnpm --filter @anreal/api exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/chat/router.ts apps/api/src/modules/static-sites/service.ts apps/api/src/modules/static-sites/service.test.ts
git commit -m "feat(sites): version pointer and remove router trigger"
```
(Stage by exact paths after `git status`; include `interaction-resume.test.ts` only if Step 1 touched it.)

---

### Task 4: Static preview + by-session + rollback routes

**Files:**
- Modify: `apps/api/src/modules/static-sites/download.ts` (extend the existing `siteDownloadRouter` — same file, same auth, same guards)
- Test: `apps/api/src/modules/static-sites/download.test.ts` (extend)

**Interfaces:**
- Consumes: Task 3 manifest/index helpers.
- Produces:
  - `GET /api/sites/:siteId/v:version/preview/*` → dist file bytes with content-type, `index.html` fallback for directory/unknown subpaths, 404 unknown site/version, 400 traversal/invalid.
  - `GET /api/sites/by-session/:sessionId` → `{ sites: [{ siteId, version, stableVersion, status, previewUrl, downloadUrl, updatedAt }] }` scanned from `sites-index.json` + manifests (index entry without manifest → skipped, never throws).
  - `POST /api/sites/:siteId/rollback { version }` → 404 unknown, 409 version not ready, else sets `stableVersion`, returns manifest; download + badge follow the pointer.

- [ ] **Step 1: Write the failing tests**

Append to `download.test.ts` (keep existing cases; reuse its `SITE_DATA_DIR` stub-env + requireUser-mock setup):

```ts
describe("site static preview", () => {
  it("serves dist files with content types and index fallback", async () => {
    const dir = useTempSiteDir();
    mkdirSync(join(dir, "site-1", "v1", "assets"), { recursive: true });
    writeFileSync(join(dir, "site-1", "v1", "index.html"), "<html>hi</html>");
    writeFileSync(join(dir, "site-1", "v1", "assets", "app.css"), "body{}");
    await writeSiteManifest({
      siteId: "site-1", sessionId: "session-1", userId: "user-1", version: 1,
      status: "ready", previewUrl: null, downloadPath: "x", error: null,
      prompt: "x", stableVersion: 1, updatedAt: new Date(0).toISOString(),
    });

    const html = await siteDownloadRouter.request("/site-1/v1/preview/index.html");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("hi");

    const css = await siteDownloadRouter.request("/site-1/v1/preview/assets/app.css");
    expect(css.headers.get("content-type")).toContain("text/css");

    const fallback = await siteDownloadRouter.request("/site-1/v1/preview/some/route");
    expect(fallback.status).toBe(200);
    expect(await fallback.text()).toContain("hi");
  });

  it("rejects traversal and unknown builds", async () => {
    useTempSiteDir();
    const traversal = await siteDownloadRouter.request("/..%2Fevil/v1/preview/index.html");
    expect([400, 404]).toContain(traversal.status);
    const missing = await siteDownloadRouter.request("/nope/v9/preview/index.html");
    expect(missing.status).toBe(404);
  });
});

describe("site by-session and rollback", () => {
  it("lists session sites and moves the stable pointer", async () => {
    const dir = useTempSiteDir();
    mkdirSync(join(dir, "site-1", "v1"), { recursive: true });
    mkdirSync(join(dir, "site-1", "v2"), { recursive: true });
    writeFileSync(join(dir, "site-1", "v1", "site.zip"), Buffer.from("PK-1"));
    writeFileSync(join(dir, "site-1", "v2", "site.zip"), Buffer.from("PK-2"));
    await writeSiteManifest({
      siteId: "site-1", sessionId: "session-1", userId: "user-1", version: 2,
      status: "ready", previewUrl: null, downloadPath: "x", error: null,
      prompt: "x", stableVersion: 2, updatedAt: new Date(0).toISOString(),
    });
    await writeSitesIndex({ "session-1": "site-1" }, dir);

    const list = await siteDownloadRouter.request("/by-session/session-1");
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      sites: [{ siteId: "site-1", version: 2, stableVersion: 2, status: "ready" }],
    });

    const rollback = await siteDownloadRouter.request("/site-1/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    expect(rollback.status).toBe(200);
    expect(await rollback.json()).toMatchObject({ stableVersion: 1 });

    const badVersion = await siteDownloadRouter.request("/site-1/rollback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 9 }),
    });
    expect(badVersion.status).toBe(409);
  });
});
```

(`useTempSiteDir`, `mkdirSync`, `writeFileSync`, `join`, `writeSiteManifest` already exist in that test file from v1 Task 8 — reuse them. `writeSitesIndex` comes from the Task 2/3 service work; import it. Rollback readiness is read from the manifest `versions` map (Task 3 shape) — no per-version files involved. The manifest fixture in these tests needs `stableVersion` + `versions` per Task 3.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/static-sites/download.test.ts`
Expected: FAIL — unknown routes/fields.

- [ ] **Step 3: Write minimal implementation**

In `download.ts`, add (same guards/imports as the file's existing routes; content-type map: `.html` → `text/html`, `.css` → `text/css`, `.js` → `text/javascript`, `.json` → `application/json`, `.svg` → `image/svg+xml`, `.png` → `image/png`, default `application/octet-stream`):

```ts
const PREVIEW_CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

siteDownloadRouter.get("/:siteId/v:version/preview/*", async (c) => {
  const siteId = c.req.param("siteId");
  const version = Number((c.req.param("version") ?? "").replace(/^v/i, ""));
  try {
    assertSafeSiteId(siteId);
  } catch {
    return c.json({ error: "invalid site id" }, 400);
  }
  if (!Number.isInteger(version) || version < 1 || version > 10_000) {
    return c.json({ error: "invalid version" }, 400);
  }
  const rest = (c.req.param("0") ?? "").replace(/^\/+/, "");
  if (rest.split("/").some((segment) => segment === ".." || segment.includes("\\"))) {
    return c.json({ error: "invalid path" }, 400);
  }
  const base = join(siteDataDir(), siteId, `v${version}`);
  const candidates = rest ? [join(base, rest), join(base, "index.html")] : [join(base, "index.html")];
  for (const candidate of candidates) {
    try {
      const bytes = await readFile(candidate);
      const extension = extname(candidate).toLowerCase();
      return new Response(bytes, {
        headers: {
          "content-type": PREVIEW_CONTENT_TYPES[extension] ?? "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    } catch {
      // try next candidate, then 404 below
    }
  }
  return c.json({ error: "preview not found" }, 404);
});
```

(Read the file first for its exact param style — the v1 route used `:version` with v-strip; `c.req.param("0")` is Hono's wildcard param name — verify against the installed hono 4.12 types before committing to it; if the wildcard param name differs, use the file's router-introspection result. `extname` from `node:path`.)

```ts
siteDownloadRouter.get("/by-session/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(sessionId ?? "")) {
    return c.json({ error: "invalid session id" }, 400);
  }
  const sites = await listSitesBySession(sessionId);
  return c.json({ sites });
});

const rollbackBody = z.object({ version: z.number().int().min(1).max(10_000) });

siteDownloadRouter.post("/:siteId/rollback", async (c) => {
  const siteId = c.req.param("siteId");
  try {
    assertSafeSiteId(siteId);
  } catch {
    return c.json({ error: "invalid site id" }, 400);
  }
  const parsed = rollbackBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid version" }, 400);
  const manifest = await readSiteManifest(siteId);
  if (!manifest) return c.json({ error: "build not found" }, 404);
  if (manifest.versions?.[parsed.data.version]?.status !== "ready") {
    return c.json({ error: "version is not ready" }, 409);
  }
  const updated = { ...manifest, stableVersion: parsed.data.version, updatedAt: new Date().toISOString() };
  await writeSiteManifest(updated);
  return c.json(updated);
});
```

(`listSitesBySession` in service.ts — created in Task 2's 1e or Task 3; if missing, create it here with a test: scan `sites-index.json` for the session, read that manifest, return one-element array shaped as the test expects; index entry without manifest → skipped. `z` import — check whether download.ts already imports zod; if not, add `import { z } from "zod"`.)

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/static-sites/download.test.ts`
Expected: PASS.

Run: `pnpm --filter @anreal/api exec tsc --noEmit`
Expected: clean (api gate is green — keep it so).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/static-sites/download.ts apps/api/src/modules/static-sites/download.test.ts apps/api/src/modules/static-sites/service.ts apps/api/src/modules/static-sites/service.test.ts
git commit -m "feat(sites): static preview, session listing, and rollback"
```
(Stage by exact paths after `git status`; include service files only if Step 3 touched them.)

---

### Task 5: Worker static URL + index write, drop container preview

**Files:**
- Modify: `apps/api/src/modules/static-sites/worker.ts`
- Test: `apps/api/src/modules/static-sites/worker.test.ts`

**Interfaces:**
- Consumes: Tasks 2-4 (index, stableVersion+versions map, static preview URL shape `/api/sites/:siteId/v:version/preview/index.html`).
- Produces: ready manifests with permanent `previewUrl` + `stableVersion` + versions entry; `sites-index.json` updated; no container preview process.

- [ ] **Step 1: Update the worker**

1a. Delete the container-preview block (the `startProcess` + `waitForPort` calls and `SITE_PREVIEW_PORT` if unused elsewhere — grep first; keep the export only if another file imports it, else delete). Keep `npm install` + `npm run build` + dist export + zip exactly as-is.

1b. After a successful build, set:
```ts
const previewUrl = `/api/sites/${siteId}/v${version}/preview/index.html`;
```
(delete the `waitForPort`-derived `http://127.0.0.1:...` construction), write the ready manifest with `stableVersion: version` and merged `versions` map entry `{ [version]: { status: "ready", updatedAt } }`, and upsert the session index (`writeSitesIndex({ ...existing, [sessionId]: siteId })` — read index first so other sessions survive).

1c. Update `worker.test.ts`: fake needs no `startProcess`/`waitForPort` (delete those fakes only if the worker no longer calls them — it must not); assert ready manifest contains the static previewUrl, `stableVersion: 1`, versions map entry, and that the index write was called (inject index read/write via deps or assert with temp `SITE_DATA_DIR` like service tests — follow whichever the current test file already does for manifests; read it first).

- [ ] **Step 2: Run tests + typecheck**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/static-sites/worker.test.ts`
Expected: PASS.

Run: `pnpm --filter @anreal/api exec tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/static-sites/worker.ts apps/api/src/modules/static-sites/worker.test.ts
git commit -m "feat(sites): permanent static preview and session index"
```

---

### Task 6: Panel relocation, card styling, history, rehydrate

**Files:**
- Modify: `apps/platform/src/components/workspace/chat-route-view.tsx` (pass panel via `composerTopSlot`, remove below-chat render)
- Modify: `apps/platform/src/components/sites/site-build-panel.tsx` (card, VersionList, rollback, rehydrate props)
- Test: `apps/platform/src/components/sites/site-build-panel.test.tsx`
- Modify: `apps/platform/src/lib/chat/client-data.ts` ONLY if a new event/field is needed (it is not — versions/rollback travel over REST + existing events; do not touch it)

**Interfaces:**
- Consumes: Tasks 4-5 (by-session + rollback + static preview URLs), existing `composerTopSlot?: ReactNode` prop on `ChatSession` (line 353-354 — "Rendered above the composer"), existing `onSiteBuildEvent` plumbing.
- Produces: panel renders between transcript and composer inside `ChatSession`; card styling; version list with stable badge + rollback buttons; rehydrate on load.

- [ ] **Step 1: Restyle + history (failing tests first)**

Read FIRST (all three, before writing anything): `apps/platform/src/components/composer/deep-research-activity-panel.tsx` (activity-panel visual language: card container, stepper, status text), `apps/platform/src/components/chat/clarification-panel.tsx` (choice buttons + retry/error patterns), and the current `site-build-panel.tsx` (91 lines). Reuse, in order: (1) the exact card container classes both panels share (copy the class string, do not invent new ones); (2) the existing `Button` from `components/ui/button.tsx` for retry/rollback (check its props first — do not hand-roll `<button>`); (3) skeleton/loading classes already in the codebase (`skeleton-shimmer`, used in chat-route-view loading state).

Extend the panel (keep `SITE_BUILD_PHASES`, `phaseIndex`, `applySiteBuildEvent`, stepper, skeleton, iframe, download link byte-identical in behavior):

```tsx
export type SiteVersionEntry = {
  version: number;
  status: "queued" | "running" | "ready" | "failed";
  stable: boolean;
  previewUrl: string | null;
  downloadUrl: string | null;
};

export function SiteBuildPanel({
  build,
  versions,
  onRetry,
  onRollback,
}: {
  build: SiteBuildState | null;
  versions: SiteVersionEntry[];
  onRetry: (siteId: string) => void;
  onRollback: (siteId: string, version: number) => void;
}) {
  if (!build) return null;
  const active = phaseIndex(build.phase);
  return (
    <section aria-label="Site build" className="...card classes copied from deep-research-activity-panel...">
      <p>v{build.version} · {build.message}</p>
      <ol>{/* stepper unchanged */}</ol>
      {build.phase === "failed" ? (
        <Button onClick={() => onRetry(build.siteId)}>Coba lagi</Button>
      ) : null}
      {build.previewUrl ? (
        <iframe title={`Preview ${build.siteId}`} src={build.previewUrl} sandbox="allow-scripts" />
      ) : (
        <div role="status">Pratinjau segera hadir.</div>
      )}
      {build.downloadUrl ? <a href={build.downloadUrl} download>Unduh zip</a> : null}
      {versions.length > 1 ? (
        <ol aria-label="Versi">
          {versions.map((entry) => (
            <li key={entry.version}>
              v{entry.version}
              {entry.stable ? " (stabil)" : null}
              {!entry.stable && entry.status === "ready" ? (
                <Button onClick={() => onRollback(build.siteId, entry.version)}>Rollback</Button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
```

(Replace the `...card classes...` with the literal class string copied from deep-research-activity-panel — no invented styling. If that panel has no single card class, copy the closest container classes from clarification-panel and note the source in the commit-nothing; just use them.)

Extend the test file: version list renders with stable marker, rollback button calls `onRollback(siteId, version)`, no list for single version, retry still works, stepper/skeleton/iframe/download assertions unchanged and passing.

Run: `pnpm --filter @anreal/platform exec vitest run src/components/sites/site-build-panel.test.tsx`
Expected: FAIL (no VersionList yet), then PASS after implementation.

- [ ] **Step 2: Relocate via composerTopSlot + rehydrate**

In `chat-route-view.tsx`: delete the below-`ChatSession` `<SiteBuildPanel .../>` render (line ~193); pass it as `composerTopSlot={siteBuild ? <SiteBuildPanel build={siteBuild} versions={siteVersions} onRetry={retrySiteBuild} onRollback={rollbackSiteBuild} /> : null}` on `<ChatSession>` (read the `composerTopSlot` prop type at chat-session.tsx:353-354 first — it takes `ReactNode`, nullable accepted; confirm `ChatSession` renders the slot between transcript and composer, not below the composer).

Add beside `retrySiteBuild`:
```tsx
const [siteVersions, setSiteVersions] = useState<SiteVersionEntry[]>([]);

const rollbackSiteBuild = useCallback(async (siteId: string, version: number) => {
  const response = await fetch(`/api/sites/${siteId}/rollback`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  });
  if (!response.ok) return;
  const manifest = (await response.json()) as { stableVersion: number };
  setSiteVersions((prev) =>
    prev.map((entry) => ({ ...entry, stable: entry.version === manifest.stableVersion })),
  );
}, []);

const refreshSiteVersions = useCallback(async (sessionId: string) => {
  const response = await fetch(`/api/sites/by-session/${sessionId}`);
  if (!response.ok) return;
  const data = (await response.json()) as { sites: { siteId: string; version: number; stableVersion: number; status: string; previewUrl: string | null; downloadUrl: string | null }[] };
  const latest = data.sites[0];
  if (!latest) return;
  setSiteVersions(
    Array.from({ length: latest.version }, (_, index) => {
      const version = index + 1;
      return {
        version,
        status: version === latest.version ? latest.status : "ready",
        stable: version === latest.stableVersion,
        previewUrl: version === latest.version ? latest.previewUrl : `/api/sites/${latest.siteId}/v${version}/preview/index.html`,
        downloadUrl: version === latest.version ? latest.downloadUrl : `/api/sites/${latest.siteId}/v${version}/download`,
      };
    }),
  );
  if (latest.status === "ready" || latest.status === "failed") {
    setSiteBuild((prev) =>
      prev?.siteId === latest.siteId
        ? prev
        : {
            siteId: latest.siteId,
            version: latest.version,
            phase: latest.status === "ready" ? "ready" : "failed",
            message: latest.status === "ready" ? "Situs siap diunduh." : "Build gagal.",
            previewUrl: latest.previewUrl,
            downloadUrl: latest.downloadUrl,
          },
    );
  }
}, []);
```

Call `refreshSiteVersions(input.sessionId)` on mount/session change (beside existing route-data effect — read the file's effects first and attach next to them) so reloads rehydrate. (Statuses of older versions are `ready` by construction — only ready versions get a successor, failed builds never advance; state this invariant in neither code nor comment, just implement it.)

Run: `pnpm --filter @anreal/platform exec vitest run src/components/sites/ src/lib/chat/`
Expected: PASS.

Run: `pnpm --filter @anreal/platform exec tsc --noEmit -p tsconfig.json`
Expected: clean apart from the parked `finalize-interrupted-tools.test.ts` arity error (do not touch that file).

- [ ] **Step 3: Commit**

```bash
git add apps/platform/src/components/workspace/chat-route-view.tsx apps/platform/src/components/sites/site-build-panel.tsx apps/platform/src/components/sites/site-build-panel.test.tsx
git commit -m "feat(platform): site panel card above composer with history"
```
(Stage by exact paths after `git status`.)

---

### Task 7: Docs + final verification (Muse Spark smoke)

**Files:**
- Modify: `README.md` (v2 behaviors: iteration via clarification, version history + rollback, permanent preview, panel location)
- Modify: `.env.example` ONLY if a new var is needed (none planned — verify; do not add speculative vars)

**Interfaces:**
- Consumes: all previous tasks.
- Produces: documented v2, full green matrix + live smoke evidence.

- [ ] **Step 1: Document v2**

In `README.md`, extend the Multi-session row / add a Sites row describing: follow-up prompts iterate via agent recommendation + user confirmation, version history with rollback, permanent static preview, panel above composer. (Read the table first, match its terse style; no new sections.)

- [ ] **Step 2: Run the full verification matrix**

Run: `pnpm --filter @anreal/agent test`
Run: `pnpm --filter @anreal/agent exec tsc --noEmit -p tsconfig.json`
Run: `pnpm --filter @anreal/api test`
Run: `pnpm --filter @anreal/api exec tsc --noEmit`
Run: `pnpm --filter @anreal/platform test`
Run: `pnpm --filter @anreal/platform exec tsc --noEmit -p tsconfig.json`
Run: `git diff --check`
Expected: green apart from the 3 parked pre-existing reds (2 api test assertions, agent wrap-tool tsc, platform finalize-interrupted-tools tsc — all verified on BASE in v1; do not touch those files). Any NEW red is a regression: stop and report BLOCKED.

- [ ] **Step 3: Real-LLM smoke with Muse Spark 1.3 Contributor**

Prerequisites (do not fake; NEEDS_CONTEXT with specifics if unavailable): Docker daemon running, `OPENAI_BASE_URL=https://openrouter.ai/api/v1` + funded key in `.env`, `SITE_ENABLED=true`, dev servers up (`pnpm dev` + `dev:worker`).
Run: `pnpm dev`, new chat, send a builder prompt. Confirm: (a) clarification appears with agent recommendation, (b) choose iterate on a follow-up → v2 builds → ready, (c) rollback to v1 works and badge/download follow, (d) static preview URL opens AFTER the sandbox container is destroyed (`docker ps` shows no site container), (e) `site.zip` downloads with `index.html`, (f) worker logs `[sites] ready`. If brief parsing falls back to JSON-from-text, note it (spec-mandated fallback, not a failure).

- [ ] **Step 4: Commit**

```bash
git add README.md .env.example
git commit -m "docs(sites): document builder v2 iteration and preview"
```
(Include `.env.example` only if Step 1 touched it; adjust the `git add` to exactly the touched files after `git status`.)

---

## Final verification

- [ ] `pnpm --filter @anreal/agent test` + `tsc --noEmit -p tsconfig.json`
- [ ] `pnpm --filter @anreal/api test` + `tsc --noEmit`
- [ ] `pnpm --filter @anreal/platform test` + `tsc --noEmit -p tsconfig.json`
- [ ] `git diff --check` clean
- [ ] Real-LLM smoke (Task 7 Step 3) passes on `meta/muse-spark-1.3-contributor`, including clarification → v2 → rollback → post-container preview

## Out of scope / follow-ups

- Main-chat language rule (separate subsystem, separate spec).
- Hosting publik, custom domain, CMS, visual editing.
- Multi-page blog, docs search, i18n.
- Backend app, database konten, auth, pembayaran.
- Deterministic design lint against the AI-fingerprint look.

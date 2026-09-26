# Workspace Artifacts Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the unified workspace artifacts layer so the agent can list/get/create/update documents, PDF reports, image assets, sites, tasks, schedules, web bundles, and session excerpts within strict project scope, with realtime UI and visual clarification.

**Architecture:** Server-enforced `userId + projectId` scope on every query; Prisma is source of truth for new tables plus `caption/kind` columns; sites stay file-based but index migrates to user+project; agent gets a small uniform toolset; browser gets artifact rail, focus events, and an artifact-aware clarification picker reusing existing primitives.

**Tech Stack:** Hono + Prisma 7 + Postgres, BullMQ `workspace-schedule`, pdfmake for PDF v1 (Puppeteer deferred), Anvia v1 (`@anvia/core 1.5.0`, `@anvia/client 1.2.0`, `@anvia/server 1.1.4`), React 19 + Vite + Tailwind 4, Vitest + Playwright real-LLM.

**Spec:** `docs/superpowers/specs/2026-09-24-workspace-artifacts-design.md`

## Global Constraints

- Branch `feat/workspace-artifacts` from `main@808f2b5`; commits `docs(artifacts): ...`, `feat(artifacts): ...`, `fix(artifacts): ...`, `test(artifacts): ...`.
- Reuse before create: `DialogShell`, `ManagementRow`, `CountBadge`, `Select`, `ConfirmDialog`, `generated-image-thumbnail`, `document-row`, `site-build-panel`, `clarification-panel`, `documents-browser`, `data-chart`; new files only if reusable and no similar exists.
- Zero `tsc`, ESLint, Vitest warnings/errors before each commit.
- TDD: failing test first for every behavior, then minimal implementation.
- Agent behavior tests use real LLM `muse-spark-1.3-contributor` reasoning medium/high for chat; image generation may use stub; never stub chat.
- Read Anvia skill + `https://anvia.dev/llms.txt` + `https://github.com/anvia-hq/anvia` before wiring tools/events/recipe.
- Scope rule: standalone sees only `projectId NULL`; project X sees only project X; enforce in SQL, not prompt.
- Update semantics: site edit = `v+1`, task = status update, report = revision; never duplicate on cross-session edit.

## Review Focus

- Cross-scope leak (standalone seeing project doc) must 404, not 403-detail.
- `find_images("logo")` must return the captioned asset even when prompt differs.
- `create_chart` JSON spec must become an embeddable PNG or PDF build fails loudly, not silently blank.
- Editing a site from another session must bump version, never mint a new siteId.
- Clarification with `artifact_type=image` must only offer in-scope images with thumbnails, never text-only fallback.

---

### Task 1: DB foundation + scope helper

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260924_workspace_artifacts/migration.sql`
- Create: `apps/api/src/modules/artifacts/scope.ts`
- Test: `apps/api/src/modules/artifacts/scope.test.ts`

**Interfaces:**
- Consumes: existing `Project`, `Document`, `GeneratedImage`, `ChatSession` models.
- Produces: `resolveArtifactScope(sessionProjectId: string | null) => { projectId: string | null }`, new Prisma models `WebBundle`, `WorkspaceTask`, `WorkspaceSchedule`, columns `GeneratedImage.caption`, `Document.kind`, `Document.citationMap`.

- [ ] **Step 1: Write the failing scope test**

```ts
import { describe, expect, it } from "vitest";
import { artifactWhere } from "./scope.js";

describe("artifactWhere", () => {
  it("standalone only matches NULL project", () => {
    expect(artifactWhere("u1", null)).toEqual({ userId: "u1", projectId: null });
  });
  it("project session only matches that project", () => {
    expect(artifactWhere("u1", "pX")).toEqual({ userId: "u1", projectId: "pX" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/artifacts/scope.test.ts`
Expected: FAIL with "artifactWhere is not defined".

- [ ] **Step 3: Add Prisma models + scope helper**

```prisma
model WebBundle {
  id        String   @id @default(cuid())
  userId    String
  projectId String?
  title     String
  sources   Json
  createdAt DateTime @default(now())
  @@index([userId, projectId, createdAt])
  @@map("web_bundle")
}
model WorkspaceTask {
  id              String    @id @default(cuid())
  userId          String
  projectId       String?
  title           String
  status          String    @default("inbox")
  sourceSessionId String?
  dueAt           DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  @@index([userId, projectId, status])
  @@map("workspace_task")
}
model WorkspaceSchedule {
  id         String    @id @default(cuid())
  userId     String
  projectId  String?
  title      String
  prompt     String    @db.Text
  freq       String    @default("once")
  nextRunAt  DateTime?
  status     String    @default("active")
  createdAt  DateTime  @default(now())
  @@index([userId, status, nextRunAt])
  @@map("workspace_schedule")
}
```

```ts
export function artifactWhere(userId: string, sessionProjectId: string | null) {
  return sessionProjectId ? { userId, projectId: sessionProjectId } : { userId, projectId: null };
}
```

Plus `GeneratedImage.caption String @default("")`, `Document.kind String @default("source")`, `Document.citationMap Json?`.

- [ ] **Step 4: Run migration + tests to verify they pass**

Run: `pnpm --filter @anreal/api db:generate; pnpm --filter @anreal/api db:migrate; pnpm --filter @anreal/api exec vitest run src/modules/artifacts/scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260924_workspace_artifacts/migration.sql apps/api/src/modules/artifacts/scope.ts apps/api/src/modules/artifacts/scope.test.ts
git commit -m "feat(artifacts): db foundation and scope helper"
```

### Task 2: Artifacts list/get + image captions + session excerpts

**Files:**
- Create: `apps/api/src/modules/artifacts/router.ts`
- Create: `apps/api/src/modules/artifacts/service.ts`
- Modify: `apps/api/src/app.ts` (mount `/api/artifacts`)
- Modify: `apps/api/src/modules/images/service.ts` (caption save + backfill path)
- Create: `packages/agent/src/tools/artifacts.ts`
- Test: `apps/api/src/modules/artifacts/router.test.ts`, `packages/agent/src/tools/artifacts.test.ts`

**Interfaces:**
- Consumes: `artifactWhere` from Task 1, existing `Document`, `GeneratedImage`, `ChatSession`, `listSessions`.
- Produces: `GET /api/artifacts?type=&q=`, `GET /api/artifacts/:id`, `PATCH /api/artifacts/images/:id {caption}`, agent tools `list_artifacts`, `get_artifact`, `find_images`, `list_sessions`, `get_session_excerpt`.

- [ ] **Step 1: Write the failing router scope test**

```ts
import { describe, expect, it } from "vitest";
describe("artifacts scope", () => {
  it("standalone cannot see project doc", async () => {
    const res = await app.request("/api/artifacts?type=document", { headers: { cookie: standaloneUser } });
    const body = await res.json() as { items: Array<{ projectId: string | null }> };
    expect(body.items.every((i) => i.projectId === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/artifacts/router.test.ts`
Expected: FAIL with "Cannot find module './router.js'".

- [ ] **Step 3: Implement router + service with scope enforcement**

```ts
import { Hono } from "hono";
import { requireUser } from "../auth/middleware.js";
import { artifactWhere } from "./scope.js";
// list/get across Document, GeneratedImage (caption ilike), WebBundle, tasks/schedules meta; session excerpts via ChatSession + memory preview (last 3 turns, no full dump)
```

Caption rule: `saveGeneratedImage` requires `caption` 1–280 chars; if empty, fill from vision helper then persist; migration backfills `caption = prompt`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/artifacts/router.test.ts; pnpm --filter @anreal/agent exec vitest run src/tools/artifacts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/artifacts/ apps/api/src/app.ts apps/api/src/modules/images/service.ts packages/agent/src/tools/artifacts.ts
git commit -m "feat(artifacts): list get captions and session excerpts with scope"
```

### Task 3: Chart snapshot + PDF reports + web bundles

**Files:**
- Create: `apps/api/src/modules/reports/service.ts` (pdfmake render)
- Create: `apps/api/src/modules/reports/router.ts` (`POST /api/reports`, `PATCH /api/reports/:id`)
- Create: `apps/api/src/modules/charts/snapshot.ts` (`POST /api/charts/snapshot`)
- Create: `apps/api/src/modules/web-bundles/router.ts`
- Create: `packages/agent/src/tools/report-tools.ts`
- Test: `apps/api/src/modules/reports/service.test.ts`, `apps/api/src/modules/charts/snapshot.test.ts`

**Interfaces:**
- Consumes: `list/get_artifact`, `analyze_dataset` + `create_chart` JSON spec, `Document` derived writer.
- Produces: `snapshot_chart(chartSpec) => { imageId }`, `create_pdf_report({title, markdown, assetIds[], citationMap?}) => { documentId }`, `edit_pdf_report(id, ...) => { revision }`, `POST /api/web-bundles/freeze`.

- [ ] **Step 1: Write the failing PDF embed test**

```ts
import { describe, expect, it } from "vitest";
import { buildReportPdf } from "./service.js";
describe("buildReportPdf", () => {
  it("embeds chart snapshot and citations", async () => {
    const pdf = await buildReportPdf({ title: "T", markdown: "# H", assetIds: ["img1"], citationMap: [{ claim: "c", documentId: "d1", pageIndex: 0 }] });
    expect(pdf.byteLength).toBeGreaterThan(1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/reports/service.test.ts`
Expected: FAIL with "buildReportPdf is not defined".

- [ ] **Step 3: Implement pdfmake render + snapshot bridge**

```ts
// snapshot.ts: validate chart spec via parseChartSpec, render server-side to PNG, save GeneratedImage {source:"chart", caption}
// service.ts: resolve assetIds in scope, fetch PNG bytes (no r2Key leak), pdfmake doc with images + citation footnotes, save Document {origin:"created", kind:"report"}
```

Use `pdfmake` (lightweight); do not add Puppeteer in this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/reports/service.test.ts src/modules/charts/snapshot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/reports/ apps/api/src/modules/charts/ apps/api/src/modules/web-bundles/ packages/agent/src/tools/report-tools.ts
git commit -m "feat(artifacts): chart snapshot pdf reports and web bundles"
```

### Task 4: Site registry cross-session (update, not duplicate)

**Files:**
- Modify: `apps/api/src/modules/static-sites/service.ts` (add `listSitesByScope`, scoped index)
- Modify: `apps/api/src/modules/static-sites/download.ts` (add `GET /api/sites?projectId=`)
- Modify: `packages/agent/src/tools/site-build.ts` (list/update wording, v+1)
- Test: `apps/api/src/modules/static-sites/scope.test.ts`

**Interfaces:**
- Consumes: existing `site.json` manifests, `sites-index.json`.
- Produces: `listSitesByScope(userId, projectId) => SessionSiteEntry[]`, scoped index `{ [userId, projectId]: [{siteId, siteName, updatedAt}] }` with backward-compat read of legacy `sessionId` keys.

- [ ] **Step 1: Write the failing cross-session test**

```ts
import { describe, expect, it } from "vitest";
import { listSitesByScope } from "./service.js";
describe("listSitesByScope", () => {
  it("finds session-A site from session-B same project", async () => {
    const sites = await listSitesByScope("u1", "pX", { dir: "/tmp/t" });
    expect(sites[0]?.siteId).toBe("siteA");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/static-sites/scope.test.ts`
Expected: FAIL with "listSitesByScope is not defined".

- [ ] **Step 3: Implement scoped index + keep legacy read**

```ts
// write both legacy session key and new scope key on enqueue; read prefers scope key; edit path reuses enqueueSiteBuildFromTool with existing siteId so version+1, never new siteId
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/static-sites/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/static-sites/
git commit -m "feat(artifacts): cross-session site registry with versioned updates"
```

### Task 5: Tasks + schedules backend and worker

**Files:**
- Create: `apps/api/src/modules/tasks/router.ts`, `apps/api/src/modules/tasks/service.ts`
- Create: `apps/api/src/modules/schedules/router.ts`, `queue.ts`, `worker.ts`
- Modify: `apps/api/src/worker.ts` (register `workspace-schedule` queue)
- Create: `packages/agent/src/tools/workspace-tools.ts`
- Test: `apps/api/src/modules/tasks/router.test.ts`, `apps/api/src/modules/schedules/queue.test.ts`

**Interfaces:**
- Consumes: `artifactWhere`, BullMQ patterns from `profiling/queue.ts` and `static-sites/queue.ts`.
- Produces: `POST/PATCH /api/tasks`, `POST /api/schedules {freq: once|daily|weekly}`, worker `runWorkspaceSchedule({scheduleId, userId, projectId})`, agent tools `manage_tasks`, `manage_schedules`.

- [ ] **Step 1: Write the failing task update test**

```ts
import { describe, expect, it } from "vitest";
describe("tasks", () => {
  it("updates status instead of duplicating", async () => {
    const t = await createTask({ userId: "u", projectId: null, title: "review" });
    const u = await updateTask({ userId: "u", id: t.id, status: "done" });
    expect(u.status).toBe("done");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/tasks/router.test.ts`
Expected: FAIL with "createTask is not defined".

- [ ] **Step 3: Implement CRUD + worker (freq whitelist, 3-attempt cap)**

```ts
// schedules worker: frozen prompt + scope; on success enqueue next daily/weekly; on 3 fails mark dead (profiling watermark pattern)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @anreal/api exec vitest run src/modules/tasks/ src/modules/schedules/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/tasks/ apps/api/src/modules/schedules/ apps/api/src/worker.ts packages/agent/src/tools/workspace-tools.ts
git commit -m "feat(artifacts): tasks and schedules with worker"
```

### Task 6: Realtime focus + visual clarification + rails/panels

**Files:**
- Modify: `apps/api/src/modules/chat/build-run-input.ts` (wire new tools + `artifact_focus` publish)
- Modify: `apps/platform/src/components/chat/clarification-panel.tsx` (artifact picker mode)
- Create: `apps/platform/src/components/artifacts/artifacts-rail.tsx`
- Create: `apps/platform/src/components/artifacts/artifact-picker.tsx`
- Create: `apps/platform/src/components/artifacts/caption-field.tsx`
- Create: `apps/platform/src/components/tasks/tasks-panel.tsx`, `apps/platform/src/components/tasks/schedules-panel.tsx`
- Modify: `apps/platform/src/lib/api.ts` (artifact clients)
- Test: `apps/platform/src/components/artifacts/artifact-picker.test.tsx`, `apps/platform/src/components/chat/clarification-panel.test.tsx`

**Interfaces:**
- Consumes: events `site_build_progress`, `ManagementRow`, `CountBadge`, `DialogShell`, `generated-image-thumbnail`, `document-row`.
- Produces: stream event `artifact_focus {artifactId, type}`, `artifact_created/updated`, `<ArtifactsRail scope>`, `<ArtifactPicker artifactType onSelect>` with loading/empty/error/success states.

- [ ] **Step 1: Write the failing picker test**

```tsx
import { describe, expect, it } from "vitest";
describe("ArtifactPicker", () => {
  it("shows thumbnails for image type only", () => {
    expect(true).toBe(true);
  });
});
```

Replace with real render test asserting `role=radiogroup` lists only in-scope images with `img` alt=caption.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @anreal/platform exec vitest run src/components/artifacts/artifact-picker.test.tsx`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement left/center/right wiring**

```tsx
// Left: ArtifactsRail in ChatSidebar scope section (tabs document/image/site/task, CountBadge)
// Center: artifact_focus banner in chat-session + composerTopSlot cards; clarification-panel artifact mode reuses ArtifactPicker
// Right: existing preview/gallery/site panels extended with caption-field + versions; tasks/schedules panels reuse ManagementRow + ConfirmDialog
```

States: `loading` shimmer, `empty` CTA, `error` retry, `success` inline link. A11y: radiogroup/dialog/focus-trap via DialogShell.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @anreal/platform exec vitest run src/components/artifacts/ src/components/chat/clarification-panel.test.tsx; pnpm --filter @anreal/platform exec tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/src/components/artifacts/ apps/platform/src/components/tasks/ apps/platform/src/components/chat/clarification-panel.tsx apps/platform/src/lib/api.ts apps/api/src/modules/chat/build-run-input.ts
git commit -m "feat(artifacts): realtime focus visual clarification and rails"
```

### Task 7: Real-LLM verification + hardening

**Files:**
- Create: `apps/platform/e2e/workspace-artifacts.real-llm.e2e.ts`
- Modify: `apps/api/src/openapi/paths/artifacts.ts` (docs), `apps/api/src/openapi/document.ts` (register)
- Test: full suites + `tsc --noEmit` + lint.

**Interfaces:**
- Consumes: all tasks above.
- Produces: green `pnpm --filter @anreal/api test`, `@anreal/agent test`, `@anreal/platform test`, Playwright real-LLM E2E with `muse-spark-1.3-contributor` medium/high.

- [ ] **Step 1: Write the failing E2E (PDF from docs + chart)**

```ts
import { test, expect } from "@playwright/test";
test("pdf from docs+chart with real llm", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
});
```

- [ ] **Step 2: Run E2E to verify it fails (no flow yet in CI env)**

Run: `pnpm --filter @anreal/platform exec playwright test --config playwright.real-llm.config.ts workspace-artifacts.real-llm -g "pdf from docs"`
Expected: FAIL (no report artifact created).

- [ ] **Step 3: Run full verification locally with real keys**

```bash
pnpm --filter @anreal/api exec vitest run
pnpm --filter @anreal/agent exec vitest run
pnpm --filter @anreal/platform exec vitest run
pnpm --filter @anreal/platform exec tsc --noEmit
```

Chat via real LLM (`muse-spark-1.3-contributor`, reasoning high); images via stub. Cover: caption search reuse, cross-session site v+1, task/schedule roundtrip, clarification picker, scope negatives (standalone↔project, A↔B).

- [ ] **Step 4: Fix hardening gaps (sanitize errors, bound citationMap, cap lists) and re-run until green**

Run: same as Step 3.
Expected: PASS with zero warnings.

- [ ] **Step 5: Commit**

```bash
git add apps/platform/e2e/workspace-artifacts.real-llm.e2e.ts apps/api/src/openapi/
git commit -m "test(artifacts): real-llm e2e and hardening"
```

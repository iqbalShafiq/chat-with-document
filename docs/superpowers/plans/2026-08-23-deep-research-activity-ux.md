# Deep Research Activity UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users a compact, style-consistent, expandable view of safe Deep Research activity while the bounded researcher is running.

**Architecture:** Extend the existing resumable `deep_research_progress` event with sanitized activity records and retrieval counters. Instrument the researcher tool wrappers at the server boundary, keep a small activity state reducer in the platform, and render a compact composer panel with an optional expanded timeline. Raw model reasoning and tool arguments remain private.

**Tech Stack:** TypeScript, Anvia tools, React 19, Tailwind CSS, Vitest, real browser QA with Playwright MCP.

**Spec:** `docs/superpowers/plans/2026-08-22-deep-research.md` plus the approved UX direction from the current task.

## Global Constraints

- Keep the existing single approval boundary and bounded retrieval budget.
- Never stream raw model reasoning, tool arguments, document snippets, or private URLs as activity details.
- Keep the default state compact; expanded details require an explicit user click.
- Use existing dark glass, accent, border, typography, and motion conventions.
- Use `role="status"` with polite live updates and honor reduced motion through existing utility classes.
- Preserve DeepSeek V4 Flash as the real QA model.

---

### Task 1: Add safe activity events and server instrumentation

**Files:**
- Modify: `packages/agent/src/tools/deep-research.ts`
- Test: `packages/agent/src/tools/deep-research.test.ts`
- Modify: `apps/api/src/modules/chat/build-run-input.ts`
- Test: `apps/api/src/modules/chat/deep-research-wiring.test.ts`

**Interfaces:**
- Produce `DeepResearchActivity`, `DeepResearchProgressStats`, and optional `activity`/ `stats` fields on `DeepResearchProgress`.
- Produce `boundDeepResearchTools(tools, maxSearches, onProgress?)` behavior that emits sanitized start/completion/failure activity events.
- Preserve all existing tool names, approvals, return values, and search-budget semantics.

- [ ] **Step 1: Write failing agent tests** for activity labels, sanitized payloads, counters, completion, and failure.
- [ ] **Step 2: Run the focused agent tests and confirm they fail for the missing activity behavior.**
- [ ] **Step 3: Implement the progress types, safe tool metadata, and wrapper emissions.**
- [ ] **Step 4: Wire the existing chat progress callback into the nested researcher wrappers.**
- [ ] **Step 5: Run the focused agent/API tests and confirm they pass.**

### Task 2: Add a tested platform activity state model

**Files:**
- Create: `apps/platform/src/lib/chat/deep-research-activity.ts`
- Test: `apps/platform/src/lib/chat/deep-research-activity.test.ts`

**Interfaces:**
- Produce a platform-only `DeepResearchActivityState` with phase, message, activities, and counters.
- Produce `initialDeepResearchActivityState`, `reduceDeepResearchProgress`, and `resetDeepResearchActivity`.
- Keep at most 12 recent activity records, update records by stable id, reset on a new planning phase, and preserve the latest counters.

- [ ] **Step 1: Write failing reducer tests for reset, append/update, bounded history, and malformed events.**
- [ ] **Step 2: Run the focused platform test and confirm it fails.**
- [ ] **Step 3: Implement the minimal pure reducer and parsing helpers.**
- [ ] **Step 4: Run the focused platform test and confirm it passes.**

### Task 3: Build the compact and expandable activity panel

**Files:**
- Create: `apps/platform/src/components/composer/deep-research-activity-panel.tsx`
- Modify: `apps/platform/src/components/composer/chat-composer.tsx`
- Modify: `apps/platform/src/routes/index.tsx`

**Interfaces:**
- Consume `DeepResearchActivityState` from the route and render only while the run is active or failed.
- Default view shows the current phase, latest safe message, spinner/error treatment, and retrieval counter.
- Expanded view shows a vertical timeline with grouped safe activity labels and status icons.
- The panel is keyboard accessible, uses `aria-expanded`, `aria-controls`, and a single polite live region.

- [ ] **Step 1: Add a platform component test seam through the pure state model and stable data attributes used by browser QA.**
- [ ] **Step 2: Implement the panel with existing glass/border/accent styles and reduced-motion-safe transitions.**
- [ ] **Step 3: Replace the composer’s one-line Deep Research status with the panel and connect route events to the reducer.**
- [ ] **Step 4: Run platform typecheck/build-oriented tests and inspect the rendered markup.**

### Task 4: Verify the complete workflow with real browser screenshots

**Files:**
- Create: `apps/platform/e2e/deep-research-activity.spec.ts` only if the repo’s existing browser harness can run the real flow without replacing the requested MCP run.
- Create: `output/playwright/deep-research-activity/` screenshots and snapshots as ignored QA artifacts if already covered by the repository’s artifact policy.
- Create: `docs/superpowers/reports/2026-08-23-deep-research-activity-qa.md`

**Interfaces:**
- Use the real app stack and DeepSeek V4 Flash.
- Capture screenshots for planning, researching/search activity, analyzing activity, synthesizing, completed, failed/rejected, and expanded activity states when each state is observable.
- Report exact commands, model, account/session setup, screenshots, assertions, console errors, and any limitations.

- [ ] **Step 1: Run all focused automated tests and fix failures using a regression test first.**
- [ ] **Step 2: Start the real API, worker, and platform stack with the repository’s existing environment.**
- [ ] **Step 3: Use Playwright MCP to exercise Deep Research with a real DeepSeek V4 Flash request and capture every observable state.**
- [ ] **Step 4: Exercise the expandable activity control, keyboard focus, rejected/failed state, and responsive layout.**
- [ ] **Step 5: Run final lint/typecheck/build/test commands, inspect screenshots, and write the QA report with evidence links.**

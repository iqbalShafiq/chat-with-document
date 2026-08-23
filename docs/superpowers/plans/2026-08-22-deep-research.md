# Deep Research Orchestration — Implementation Plan

> **For implementation:** Use `superpowers:executing-plans` and follow the tasks in order. Each task starts with a failing test or a reproducible verification gap, then implements the smallest complete change.

**Goal:** Deliver the Phase 2 Deep Research workflow described by `docs/superpowers/specs/2026-08-21-data-analysis-deep-research-design.md`, including a one-level nested researcher, explicit tool approval, bounded execution, progress events, citations, UI controls, and real-LLM/browser evidence.

**Architecture:** The chat agent owns a single `deep_research` tool. That tool delegates to a researcher agent through Anvia's `Agent.asTool({ stream: true })` API. The researcher receives document, web, and tabular tools but no delegation tool, so nesting stops at one level. The outer tool owns approval and reports coarse progress through the existing Redis stream event path. The final researcher output is returned to the parent and is finalized by the existing citation pipeline.

**Scope boundary:** Stay on the repository's pinned Anvia v0 API (`@anvia/core` `^0.26.0`); do not upgrade the SDK. Do not add a database migration or seed unless tests prove that persistent schema/data is required. Preserve the existing Plan 1 tabular-analysis behavior, including its intentionally presentational toggle.

## Execution status — 2026-08-22

- [x] Agent tool, one-level researcher delegation, approval policy, retrieval/turn bounds, progress events, and citation instructions implemented.
- [x] API queue/request/worker/capability/OpenAPI wiring implemented; Prisma client regenerated. No new Deep Research migration or seed was required; local drift was repaired by applying the repository's existing migrations `20260820055945_web_photo_source` and `20260822022335_add_document_tabular_data`.
- [x] Platform toggle, approval card, activity label, and visible progress state implemented.
- [x] Automated Plan 2 eval suite and headed real-LLM E2E spec added for P2-C9..P2-C13.
- [x] Agent/API/platform unit tests, typechecks, API build, and dependency synchronization pass.
- [x] Live eval runner limitation was documented and isolated: the standalone `tsx`/Node eval command did not emit or honor its timeout, so provider-dependent acceptance was verified through the headed real-LLM browser path instead.
- [x] Headed P2-C9..P2-C13 browser cases pass against the live stack across the final verification runs; evidence is written to `.playwright-mcp/deep-research/`.
- [x] Added a regression guard for rejected Deep Research so the parent cannot fall back into another retrieval approval during the same request.

## Task 1: Establish the plan and red tests

1. Add focused agent tests for: approval when the toggle is off, direct execution when it is on, researcher delegation, one-level tool isolation, progress phases, and configured turn/search budgets.
2. Add API route/queue tests for `deepResearchEnabled` round-tripping through the request and job input.
3. Add UI/component assertions for the feature toggle and progress state where the existing test setup supports them.
4. Run the focused tests and record the expected failures before implementation.

## Task 2: Implement the nested researcher

1. Add `packages/agent/src/tools/deep-research.ts` with typed scope/options, a `deep_research` tool, approval metadata, bounded researcher instructions, and progress callbacks.
2. Build the researcher with the configured model (or `DEEP_RESEARCH_MODEL`) and the existing document/web/tabular tools. Do not include `deep_research` in its tools.
3. Enforce `DEEP_RESEARCH_MAX_TURNS` and `DEEP_RESEARCH_MAX_SEARCHES` through the nested tool configuration and researcher instructions; reuse existing SQL/result caps for dataset work.
4. Require the researcher to return source-grounded findings with the existing citation marker/trailer format, preserving URLs and document page references for the existing finalizer.
5. Export the tool factory and add unit tests for the delegation contract and progress lifecycle.

## Task 3: Wire server request, approvals, progress, and citations

1. Add `deepResearchEnabled` to the chat body schema, queue job, worker destructuring, and `build-run-input` arguments.
2. Register Deep Research only when web search or active session documents make it usable; use the existing approval registry for allow-once/session/reject decisions.
3. Ensure an approved Deep Research run does not trigger a second approval for its researcher-owned web tools, while ordinary direct web-search behavior remains unchanged.
4. Append `deep_research_progress` events through the existing stream path and preserve the normal assistant citation finalization.
5. Add capability reporting and OpenAPI documentation, including the document-only availability case.

## Task 4: Wire platform controls and feedback

1. Add a Deep Research switch to the features popover and request body, with availability derived from server capability plus linked documents.
2. Add approval-panel copy and session-grant handling for `deep_research`.
3. Surface progress phases in the composer/chat timeline and add a tool activity label.
4. Keep mobile and existing feature toggles behavior unchanged.
5. Add/adjust UI tests for enabled, unavailable, approval, rejection, and running states.

## Task 5: Evidence and plan reconciliation

1. Add real-LLM evaluation cases 9–13 for direct/cited research, allow-once approval, rejection without fabricated citations, mixed CSV/PDF/web grounding, and visible progress.
2. Add or extend the hands-on MCP browser harness to collect evidence for those cases without replacing automated tests.
3. Reconcile the 72 stale unchecked Plan 1 boxes against the implementation, tests, and evidence commits; leave only genuinely outstanding items unchecked.
4. Record final verification commands and evidence links/paths in the relevant plan/eval documentation.

## Task 6: Full verification and handoff

1. Run the pinned dependency install if the local workspace is stale.
2. Run package tests, typechecks, build, eval/unit checks, and applicable browser smoke checks.
3. Inspect migration/seed scripts and run only the required checks; confirm whether no schema/data change is needed.
4. Run `git diff --check`, inspect the final diff and status, and report completed, active, and remaining work without silently changing unrelated user work.

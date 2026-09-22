# Site Builder v2 Design (iteration, panel, permanent preview)

Date: 2026-09-22
Branch: `feat/static-site-builder` (stacked on v1, unmerged)
Approach: A — session-active-site + clarification (approved)
Supersedes (partially): `2026-09-21-static-site-builder-design.md`
  (router intent trigger removed; preview served from host; panel relocated)

## Goal

Close the v1 gaps proven by the live smoke test: follow-up prompts create
versioned iterations on the same site (agent-recommended, user-confirmed),
the build panel lives between transcript and composer as a styled card with
version history and rollback, and previews survive the sandbox container via
host static serving. Main-chat language behavior is explicitly out of scope
(separate follow-up).

## Context and research

- v1 (shipped on this branch, 21 commits): Mini Vite builds in ephemeral
  Docker sandboxes, BullMQ `site-build` queue, `site.json` file metadata (no
  Prisma migration), `siteBuildProgress`/`siteBuildReady` protocol-v3 events,
  platform `SiteBuildPanel`, `GET download` + `POST retry`, real-LLM model
  `meta/muse-spark-1.3-contributor` throughout.
- Live smoke (2026-09-22, real browser + backend) proved the loop works
  (75KB valid zip, Indonesian content, worker `[sites] ready`) and exposed
  four gaps this spec closes:
  1. Panel renders below the composer as unstyled text, because it mounts
     after `ChatSession` while the composer lives inside it.
  2. No `version + 1` path exists: the router trigger mints a fresh `siteId`
     at `version: 1` on every intent match, so iterations fragment.
  3. No version history or rollback UI exists anywhere.
  4. `previewUrl` dies with the sandbox container, so the ready-state
     iframe is dead on arrival.
- Repo already owns the decision pattern this design reuses:
  `request_clarification` wizard + human approval tools.

## Global constraints

- Static-only output stays: pure `dist/` (HTML/CSS/JS), no backend, no DB,
  no auth changes. Metadata stays file-based (`site.json`, new
  `sites-index.json`); no Prisma migration.
- Single enqueue path: the v1 router intent trigger is deleted entirely.
  All builds enter through the new `propose_site_build` agent tool.
- Real-LLM verification uses exactly `meta/muse-spark-1.3-contributor`.
- Publish/append stays best-effort; a failed site enqueue never fails chat.
- Tests use repo patterns (`vi.hoisted` mocks, fake BullMQ/sandbox,
  `jsdom` for DOM). No comments unless surrounding code documents the same.
- v1 behavior for first builds is unchanged (same worker, queue, events,
  download, retry).

## Architecture

The iteration decision moves into the agent loop. A new `propose_site_build`
tool parses the brief, reads the session's active site from
`sites-index.json`, and either enqueues directly (no active site, or clearly
different topic) or raises `request_clarification` with the agent's
recommendation for the user to confirm. Only v+1 on the same site or a new
site can result — never a duplicate, never silent.

Preview becomes permanent by serving the already-exported `dist/` from the
API host: new static route, same traversal guards and auth as the download
route, `index.html` fallback. The sandbox container lifecycle is untouched
(it may die right after export). `previewUrl` in ready events points at the
static URL.

The panel becomes a first-class `ChatSession` slot between transcript and
composer: card styling, version list with stable badge, per-version rollback,
and rehydration from the server on load.

## Components

1. `propose_site_build` tool (agent) — sole enqueue entry. Input: user
   prompt + sessionId. Parses brief, reads active site, enqueues v1 / new
   site directly or via clarification. Never generates code, never touches
   Docker.
2. `sites-index.json` — map `sessionId → activeSiteId` in `SITE_DATA_DIR`.
   Written by the worker on every ready build, read by the tool. File-based,
   no migration.
3. `stableVersion` in `site.json` — pointer to the stable version; rollback
   rewrites the pointer, never deletes version data. Download links and the
   stable badge follow the pointer (in v1 the panel only ever knew the
   latest ready build, so the pointer starts there).
4. Static preview router — `GET /api/sites/:siteId/v:version/preview/*`:
   serves dist files with traversal rejection, correct content-types,
   `index.html` fallback. Download and retry routes unchanged.
5. Panel card + history — `SiteBuildPanel` gains a `ChatSession` slot
   between transcript and composer, card styling per app theme, `VersionList`
   (stable badge + rollback button), and server rehydration via new
   `GET /api/sites/by-session/:sessionId`.
6. Router trigger removal — the v1 intent block in `router.ts` (and its
   now-dead import surface) is deleted. No dual enqueue paths.

## Data flow

1. User prompt → main agent runs → calls `propose_site_build`.
2. Tool parses brief → checks index: no active site → enqueue v1; clearly
   different topic → new site; similar/ambiguous → `request_clarification`
   with recommendation → user picks → enqueue v+1 or new site.
   "Clearly different" is agent judgment on the brief vs the active site
   (name, audience, topic) — no fixed similarity rule; when in doubt the
   tool must ask rather than guess.
3. Worker builds exactly as v1 (sandbox → build → zip → manifest), except
   `previewUrl` is the permanent host static URL.
4. Progress/ready events unchanged → panel (new slot) updates live; new
   versions append to the list; stable badge follows the newest ready build.
5. Rollback: `POST /api/sites/:siteId/rollback {version}` moves
   `stableVersion`; download + badge follow; no files deleted.
6. Reload: panel fetches `by-session` and renders active site + versions
   (no longer lost, unlike v1 in-memory state).

## Error handling

- Brief/parse failure inside the tool → error text back to the agent; chat
  unaffected; nothing enqueued.
- Unanswered/skipped clarification → no enqueue, no partial state.
- Static serving: outside dist or unknown version → 404; traversal → 400.
- Rollback to failed/missing version → 409.
- Corrupt index → treated as no active site (warn logged), new-site path.
- All v1 worker guarantees hold (best-effort events, failed status + retry,
  Docker-down explicit failure).

## Testing

Unit (repo patterns): tool routing (direct v1 / new site / clarification +
recommendation correctness), index read/write, stableVersion + rollback
endpoint incl. 409s, static serving (file ok, traversal 400, index fallback,
content-types), panel (stepper, version list, rollback click, rehydrate on
load). E2E stub keeps `SITE_ENABLED=false`. Real-LLM smoke on
`meta/muse-spark-1.3-contributor`: prompt → clarification appears → choose
iterate → v2 ready → rollback to v1 → static preview opens after the
container is gone → zip downloads.

Verifikasi akhir: `agent`/`api`/`platform` test + `tsc --noEmit` each green
(apart from the 3 parked pre-existing reds), `git diff --check` clean.

## Out of scope / follow-ups

- Main-chat language rule (separate subsystem, separate spec).
- Hosting publik, custom domain, CMS, visual editing.
- Multi-page blog, docs search, i18n.
- Backend app, database konten, auth, pembayaran.
- Deterministic design lint against the AI-fingerprint look.

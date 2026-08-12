# Session Freshness Check Before Send

Date: 2026-08-09

## Problem

Two related issues:

1. **Human approval / clarification on return** — a pending tool approval or
   clarification is tied to a running stream. When the user closes the tab or
   switches sessions, the UI must re-show the panel when they come back. A
   rejoin mechanism already exists (mount effect → `fetchRunStatus` →
   `resumeChatRef` replays stream events from `lastEventId`), so approvals
   reappear while the run is still polling (approval 5 min, clarification
   10 min). This design includes a browser verification of that path.

2. **Stale session across windows/devices** — a window kept open while the
   session changed elsewhere stays stale:
   - Normal send from a stale client is harmless for the agent (context comes
     from server memory), but the local view stays behind.
   - **Resubmit/revert from a stale client is destructive**: `truncateSessionMemory`
     deletes memory rows from the target position onward, including messages
     added by another window/device.

## Design (approved)

### Server

New endpoint `GET /api/chat/session-state?sessionId=` → `{ messageCount }`,
counting `agentMemoryMessage` rows with role `user` or `assistant` (tool rows
are merged into assistant messages on the UI and are not counted).

### Staleness rule

`stale ⟺ server.messageCount > localCount` where `localCount` is the number of
local UI messages with role `user` or `assistant`.

- No false positives on normal flow: messages from a completed run are already
  persisted in server memory.
- Server being *shorter* (truncated/compacted elsewhere) is intentionally NOT
  stale: resubmitting at a local position beyond server max deletes nothing
  extra.
- Fetch failure → fail-open (proceed as today).

### Client

1. **Normal send** (composer submit): if stale → dialog with **[Reload]** /
   **[Kirim tetap]**. Reload refetches history and keeps the composer text;
   "Kirim tetap" appends normally.
2. **Resubmit / revert** (`resubmitFromUserMessage`, before truncate): if
   stale → dialog with **[Reload] only** (blocked). Reload exits edit mode and
   refreshes history; the user reviews, then edits again.

### Out of scope

- Periodic passive banner when a session changes elsewhere.
- Real-time cross-window sync.
- Equal-count edits elsewhere (undetectable cheaply).

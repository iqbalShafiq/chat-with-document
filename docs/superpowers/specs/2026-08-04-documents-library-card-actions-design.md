# Documents Library — Card Actions, Line Clamp Fix, Shared Button

Date: 2026-08-04
Status: Approved by user (design presented 2026-08-04)

## Goal

Polish the Documents library page (`apps/platform/src/components/documents/documents-browser.tsx` + `document-row.tsx`):

1. Fix the summary clamp: max 2 lines with ellipsis at end of line 2 (no half-cut 3rd line).
2. Preview action becomes an icon button that reuses a shared button component (currently a raw `<button>` without `cursor-pointer`).
3. Add a delete action (icon button) that opens the existing `ConfirmDialog` before deleting permanently.

Reuse/extend existing components, logics, helpers, and utils; create new pieces only where they are reusable and scalable.

## Current State (verified 2026-08-04)

- `document-row.tsx` card layout already uses `line-clamp-2` but with `min-h-[2.75rem]` (44px). Two lines at `text-[11px]` / `leading-relaxed` (1.625) are ≈35.75px, so the reserved min-height leaves a gap that visually reads as a half-cut 3rd line.
- No shared `Button` component exists. The codebase uses raw `<button>` elements with inline Tailwind classes, plus class constants `DIALOG_PRIMARY_BUTTON_CLASS` / `DIALOG_SECONDARY_BUTTON_CLASS` in `apps/platform/src/components/ui/dialog-actions.tsx` (used by `confirm-dialog.tsx`, `document-library-modal.tsx`, `projects-browser.tsx`).
- The "Preview full content" button in `documents-browser.tsx` is a full-width raw `<button>` without `cursor-pointer`.
- There is no delete-document endpoint. `deleteProject` in `apps/api/src/modules/projects/service.ts` is the established pattern: DB transaction first, then best-effort external cleanup (`deleteObject` for R2, `deleteDocumentChunks` for Qdrant, errors logged).
- `ConfirmDialog` already exists (`apps/platform/src/components/ui/confirm-dialog.tsx`) with busy/error support and is used by `projects-browser.tsx` for exactly this pattern.
- No eslint/biome config in the repo. Verification = `tsc` typecheck + `vite build`.

## Design

### 1. Line clamp fix — `document-row.tsx`

Card summary `<p>` keeps `line-clamp-2` (ellipsis at end of line 2) but replaces `min-h-[2.75rem]` with `min-h-[3.25em]` — exactly two lines at 11px font / 1.625 line-height, removing the phantom third-line gap while keeping cards aligned in the grid. Apply to both the summary branch and the "No summary available" placeholder branch.

### 2. Shared `Button` component — new `apps/platform/src/components/ui/button.tsx`

- Single `Button` component with:
  - `variant`: `"primary" | "secondary" | "ghost" | "danger"`
  - `size`: `"sm" | "md" | "icon"`
  - `iconOnly` convenience (`icon` size + `aria-label` required)
  - `className` passthrough, `cursor-pointer` built in, disabled styles, focus ring.
- Refactor `dialog-actions.tsx` so `DIALOG_PRIMARY_BUTTON_CLASS` / `DIALOG_SECONDARY_BUTTON_CLASS` become compositions derived from the button class map — exported constant names stay the same so existing call sites (ConfirmDialog, DocumentLibraryModal, ProjectsBrowser) do not change.

### 3. Card actions — `documents-browser.tsx`

Replace the full-width "Preview full content" button with two icon buttons in the card trailing area (bottom-right, `justify-end`, gap-2):

- Preview: `Button` ghost icon + `Eye` icon, `aria-label="Preview full content"`, opens the existing preview modal.
- Delete: `Button` ghost icon + `Trash2` icon, danger hover treatment, `aria-label="Delete document"`.

### 4. Delete flow (endpoint + UI)

- **API service** `apps/api/src/modules/documents/service.ts`: `deleteUserDocument({ userId, documentId })`:
  - Look up document owned by user (`findFirst` by id + userId).
  - Return null if not found (404).
  - DB transaction: `prisma.document.delete` (pages + sessionLinks cascade via FK).
  - Best-effort external cleanup after commit: `deleteObject(r2Key)` and `deleteDocumentChunks(documentId)`, errors logged — mirroring `deleteProject`.
- **Router** `apps/api/src/modules/documents/router.ts`: `DELETE /api/documents/:id?confirm=true` (confirm required, matching the projects pattern), 404 when missing.
- **Client** `apps/platform/src/lib/api.ts`: `deleteUserDocument(documentId)` following `deleteProject`'s fetch/error pattern.
- **UI**: `deleteTarget` state in `documents-browser.tsx`; clicking trash opens existing `ConfirmDialog` ("Delete document?", filename in description, permanent removal wording, busy state, error shown inline). On success: remove from `items`, close the preview modal if it is showing that document. Restore focus handled by `ConfirmDialog`'s `restoreFocusRef` (pass the delete trigger ref).

### 5. Verification

- `pnpm --filter api build` (tsc) — must be clean.
- `pnpm --filter platform exec tsc --noEmit` and `pnpm --filter platform build` (vite) — must be clean.
- Manual smoke via dev server + browser: summary shows exactly 2 lines with ellipsis, preview icon button works, delete flow shows confirmation and removes the row, storage usage drops.

## Out of Scope

- Delete from the attach modal (`document-library-modal.tsx`) — browser only, per user decision.
- Unlink (session rail) behavior — unchanged.
- Any lint setup — none exists in the repo.

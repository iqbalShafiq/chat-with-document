# Documents Library Card Actions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the Documents library: exact 2-line summary clamp with end ellipsis, shared `Button` component, preview as icon button, and a delete flow with the existing `ConfirmDialog` backed by a new `DELETE /api/documents/:id` endpoint.

**Architecture:** Backend delete mirrors the established `deleteProject` pattern (DB transaction → best-effort R2/Qdrant cleanup). Platform side introduces one reusable `Button` component (`components/ui/button.tsx`) that `dialog-actions.tsx` constants compose from, then rewires the library card actions through it.

**Tech Stack:** React 19 + Tailwind CSS v4 + Vite + TanStack Router (platform); Hono + Prisma 7 + BullMQ + Qdrant via `@assingment/agent` (api); lucide-react icons.

## Global Constraints

- **No test framework exists in this repo.** Platform has no test script; api uses `tsx` smoke scripts only. Task verification = typecheck/build gates below + manual smoke with the dev servers. Do NOT introduce a test framework.
- Typecheck/build gates: api → `pnpm --filter api build`; platform → `pnpm --filter platform exec tsc --noEmit` and `pnpm --filter platform build`.
- Reuse existing helpers verbatim: `deleteObject` (`apps/api/src/lib/r2.ts`), `deleteDocumentChunks` (exported from `@assingment/agent`), `ConfirmDialog` (`apps/platform/src/components/ui/confirm-dialog.tsx`), `DialogShell` — no new modal primitives.
- Preserve the exported constant names `DIALOG_PRIMARY_BUTTON_CLASS` / `DIALOG_SECONDARY_BUTTON_CLASS` — existing call sites (`confirm-dialog.tsx`, `document-library-modal.tsx`, `projects-browser.tsx`) must keep compiling unchanged.
- Backend ownership rule: a user may only delete their own documents (`where: { id, userId }`).
- Delete is browser-only (NOT in the attach modal). Unlink (session rail) behavior is untouched.
- Each commit stages only files that belong to that task; never `git add -A`.
- No comments in code unless the surrounding file already uses doc comments (shared UI components may carry a one-line JSDoc, matching `document-row.tsx` style).

---

### Task 1: Backend delete-document endpoint

**Files:**
- Modify: `apps/api/src/modules/documents/service.ts` (add `DocumentConfirmRequiredError`, `DocumentNotFoundError`, `deleteUserDocument`)
- Modify: `apps/api/src/modules/documents/router.ts` (add `parseConfirm` helper + `DELETE /:id` route)

**Interfaces:**
- Produces:
  - `export class DocumentConfirmRequiredError extends Error` with `readonly code = "CONFIRM_REQUIRED"`
  - `export class DocumentNotFoundError extends Error` with `readonly code = "DOCUMENT_NOT_FOUND"`
  - `export async function deleteUserDocument(input: { userId: string; documentId: string; confirm: boolean }): Promise<{ deleted: true }>` — throws the two errors above
  - `DELETE /api/documents/:id?confirm=true` → 200 `{ deleted: true }` | 400 `{ error, code: "CONFIRM_REQUIRED" }` | 404 `{ error, code: "DOCUMENT_NOT_FOUND" }`

- [ ] **Step 1: Add error classes + delete function to `service.ts`**

Add imports at the top of `apps/api/src/modules/documents/service.ts` (next to the existing imports):

```ts
import { deleteDocumentChunks } from "@assingment/agent";
import { deleteObject } from "../../lib/r2.js";
```

Add after `DocumentStorageQuotaError` (line ~40):

```ts
export class DocumentConfirmRequiredError extends Error {
  readonly code = "CONFIRM_REQUIRED";
  constructor(message = "confirm=true is required to delete a document") {
    super(message);
    this.name = "DocumentConfirmRequiredError";
  }
}

export class DocumentNotFoundError extends Error {
  readonly code = "DOCUMENT_NOT_FOUND";
  constructor(message = "Document not found") {
    super(message);
    this.name = "DocumentNotFoundError";
  }
}
```

Add at the end of the file (after `getDocumentPreview`, before the `ensureSessionLink` re-export):

```ts
/**
 * Permanently delete a user's document. DB rows (pages + session links) go
 * first via FK cascade; R2 object + Qdrant chunks are best-effort after
 * commit — mirroring deleteProject.
 */
export async function deleteUserDocument(input: {
  userId: string;
  documentId: string;
  confirm: boolean;
}): Promise<{ deleted: true }> {
  if (!input.confirm) throw new DocumentConfirmRequiredError();

  const document = await prisma.document.findFirst({
    where: { id: input.documentId, userId: input.userId },
    select: { id: true, r2Key: true },
  });

  if (!document) throw new DocumentNotFoundError();

  await prisma.document.delete({ where: { id: document.id } });

  if (document.r2Key) {
    try {
      await deleteObject(document.r2Key);
    } catch (error) {
      console.error("[documents] R2 delete failed", {
        key: document.r2Key,
        error,
      });
    }
  }
  try {
    await deleteDocumentChunks(document.id);
  } catch (error) {
    console.error("[documents] Qdrant delete failed", {
      documentId: document.id,
      error,
    });
  }

  return { deleted: true };
}
```

- [ ] **Step 2: Add route to `router.ts`**

In `apps/api/src/modules/documents/router.ts`:

1. Extend the import from `./service.js`:

```ts
import {
  createDocumentUpload,
  deleteUserDocument,
  DocumentConfirmRequiredError,
  DocumentNotFoundError,
  DocumentProjectMismatchError,
  DocumentStorageQuotaError,
  getDocumentPreview,
  getDocumentStatus,
  getUserStorageUsage,
  linkDocumentsToSession,
  listSessionDocuments,
  listUserDocuments,
  unlinkDocumentFromSession,
} from "./service.js";
```

2. Add `parseConfirm` next to `requireSessionId` (top of file):

```ts
function parseConfirm(value: unknown): boolean {
  if (value === true || value === "true" || value === "1") return true;
  return false;
}
```

3. Add the route before `.get("/:id", ...)` (before line 142):

```ts
  .delete("/:id", async (c) => {
    const user = c.get("user");
    const confirmQuery = c.req.query("confirm");
    let confirmBody = false;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      confirmBody = parseConfirm(body?.confirm);
    } catch {
      // DELETE may have empty body
    }
    const confirm = parseConfirm(confirmQuery) || confirmBody;

    try {
      const result = await deleteUserDocument({
        userId: user.id,
        documentId: c.req.param("id"),
        confirm,
      });
      return c.json(result);
    } catch (error) {
      if (error instanceof DocumentNotFoundError) {
        return c.json({ error: error.message, code: error.code }, 404);
      }
      if (error instanceof DocumentConfirmRequiredError) {
        return c.json({ error: error.message, code: error.code }, 400);
      }
      throw error;
    }
  })
```

- [ ] **Step 3: Verify with typecheck**

Run: `pnpm --filter api build`
Expected: compiles with 0 errors, 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/documents/service.ts apps/api/src/modules/documents/router.ts
git commit -m "feat: add delete document endpoint with confirm guard"
```

---

### Task 2: Shared Button component

**Files:**
- Create: `apps/platform/src/components/ui/button.tsx`
- Modify: `apps/platform/src/components/ui/dialog-actions.tsx`

**Interfaces:**
- Produces:
  - `export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"`
  - `export type ButtonSize = "sm" | "md" | "icon"`
  - `export const BUTTON_BASE_CLASS: string`
  - `export const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string>`
  - `export const BUTTON_SIZE_CLASSES: Record<ButtonSize, string>`
  - `export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; className?: string })` — defaults `variant="secondary"`, `size="md"`, `type="button"`, always `cursor-pointer`, `focus-visible:ring-2 focus-visible:ring-accent-ring`
- Consumes: nothing new — pure component.

- [ ] **Step 1: Create `button.tsx`**

```tsx
import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "icon";

export const BUTTON_BASE_CLASS =
  "inline-flex cursor-pointer items-center justify-center rounded-xl font-medium transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40";

export const BUTTON_VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] hover:bg-accent-hover",
  secondary: "text-text-muted hover:bg-white/8 hover:text-text",
  ghost: "text-text-faint hover:bg-white/[0.06] hover:text-text",
  danger: "text-text-faint hover:bg-danger-soft hover:text-danger",
};

export const BUTTON_SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "min-h-8 gap-1.5 px-2.5 text-xs",
  md: "min-h-9 gap-1.5 px-3.5 text-sm",
  icon: "size-9 rounded-lg",
};

/**
 * Shared button for dialogs, cards, and icon-only actions.
 * Use size="icon" with aria-label for icon-only buttons.
 */
export function Button({
  variant = "secondary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}) {
  return (
    <button
      type={type}
      className={[
        BUTTON_BASE_CLASS,
        BUTTON_VARIANT_CLASSES[variant],
        BUTTON_SIZE_CLASSES[size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}
```

- [ ] **Step 2: Refactor `dialog-actions.tsx` to compose from Button**

Replace the whole file body:

```tsx
import {
  BUTTON_BASE_CLASS,
  BUTTON_SIZE_CLASSES,
  BUTTON_VARIANT_CLASSES,
} from "#/components/ui/button";

/**
 * Shared action button styles for DialogShell footers and ConfirmDialog.
 * Composed from the shared Button class map — visual language stays in
 * one place.
 */

export const DIALOG_PRIMARY_BUTTON_CLASS = [
  BUTTON_BASE_CLASS,
  BUTTON_VARIANT_CLASSES.primary,
  BUTTON_SIZE_CLASSES.md,
].join(" ");

export const DIALOG_SECONDARY_BUTTON_CLASS = [
  BUTTON_BASE_CLASS,
  BUTTON_VARIANT_CLASSES.secondary,
  BUTTON_SIZE_CLASSES.md,
].join(" ");
```

- [ ] **Step 3: Verify with typecheck + build**

Run: `pnpm --filter platform exec tsc --noEmit`
Expected: 0 errors, 0 warnings.
Run: `pnpm --filter platform build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/platform/src/components/ui/button.tsx apps/platform/src/components/ui/dialog-actions.tsx
git commit -m "feat: add shared Button component and compose dialog action classes"
```

---

### Task 3: Library card actions + delete flow + clamp fix

**Files:**
- Modify: `apps/platform/src/components/documents/document-row.tsx` (clamp fix)
- Modify: `apps/platform/src/components/documents/documents-browser.tsx` (icon buttons + delete flow)
- Modify: `apps/platform/src/lib/api.ts` (client `deleteUserDocument`)
- Modify: `apps/platform/src/styles.css` (`animate-fade-out` utility + reduced-motion list)

**Interfaces:**
- Consumes:
  - `deleteUserDocument(documentId: string): Promise<{ deleted: true }>` from `#/lib/api` (Task 1 contract)
  - `Button` from `#/components/ui/button` (Task 2)
  - `ConfirmDialog` from `#/components/ui/confirm-dialog` (existing)
- Produces: none (terminal task).

**Delete state machine (loading / success / error) + standard animations:**

| State | Trigger | UI reaction | Animation |
|---|---|---|---|
| `idle` | — | Trash icon button visible | Button default hover/`active:scale-[0.96]` transition |
| `loading` | trash clicked → `deleteTarget` + `deleting=true` | `ConfirmDialog` opens (busy: buttons disabled, confirm shows "Working…", cancel inert); trigger stays behind modal | `ConfirmDialog`'s existing styles only — no new animation |
| `success` | `deleteUserDocument` resolves | dialog closes, row fades out then is removed from `items` (after `--duration-fast` 160ms), preview closes if it showed that doc, file-count re-renders | `.animate-fade-out` on the `<li>` (new utility, `fade-out` keyframe: opacity 1→0, scale 1→0.98, `var(--duration-fast)` + `var(--ease-out-premium)`) |
| `error` | fetch rejects | dialog stays open, inline error text via `ConfirmDialog`'s `error` prop (`role="alert"`, danger color), buttons re-enabled, user can retry or cancel | existing dialog/error styling — matches login/register error pattern |

The new `.animate-fade-out` utility joins the other `animate-*` utilities in `styles.css` and the `prefers-reduced-motion` exclusion list, exactly like the existing ones.

- [ ] **Step 1: Fix the summary clamp in `document-row.tsx`**

Replace both `min-h-[2.75rem]` occurrences (card layout, summary branch + "No summary available" branch) with `min-h-[3.25em]`. Resulting summary `<p>`:

```tsx
<p className="line-clamp-2 min-h-[3.25em] w-full text-[11px] leading-relaxed text-text-faint">
  {summary}
</p>
```

Ellipsis stays at the end of line 2 (`line-clamp` behavior); the min-height now equals exactly 2 lines (11px × 1.625), so no phantom half-cut third line while grid cards stay aligned.

- [ ] **Step 2: Add `deleteUserDocument` to `lib/api.ts`**

Add after `deleteProject` (after line 272):

```ts
export async function deleteUserDocument(
  documentId: string,
): Promise<{ deleted: true }> {
  const response = await apiFetch(
    `${API_BASE}/api/documents/${encodeURIComponent(documentId)}?confirm=true`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? "Failed to delete document");
  }
  return (await response.json()) as { deleted: true };
}
```

- [ ] **Step 3: Add the `animate-fade-out` utility to `styles.css`**

Add after the `.stagger-item` rule (after line ~352):

```css
@keyframes fade-out {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.98);
  }
}

/* Removed items (e.g. deleted library card) — subtle exit, same cadence as entry */
.animate-fade-out {
  animation: fade-out var(--duration-fast) var(--ease-out-premium) both;
  pointer-events: none;
}
```

Then add `.animate-fade-out,` to the `prefers-reduced-motion` exclusion list (line ~690, alongside `.animate-fade-up,` etc.).

- [ ] **Step 4: Wire icon buttons + delete state machine in `documents-browser.tsx`**

1. Update imports:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Eye, FileText, FolderKanban, Search, Trash2 } from "lucide-react";
import { DocumentPreviewModal } from "#/components/documents/document-preview-modal";
import { DocumentRow } from "#/components/documents/document-row";
import { WorkspaceMainPane } from "#/components/layout/workspace-main-pane";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import { useDebouncedValue } from "#/hooks/use-debounced-value";
import { useInfiniteScrollSentinel } from "#/hooks/use-infinite-scroll-sentinel";
import {
  deleteUserDocument,
  listProjects,
  listUserDocuments,
  type ProjectListItem,
  type UserLibraryDocument,
} from "#/lib/api";
import { formatBytes } from "#/lib/documents/format-bytes";
```

2. Add state after `previewDoc` (after line 37):

```tsx
const [deleteTarget, setDeleteTarget] = useState<UserLibraryDocument | null>(
  null,
);
const [deleting, setDeleting] = useState(false);
const [deleteError, setDeleteError] = useState<string | null>(null);
const [removingId, setRemovingId] = useState<string | null>(null);
const removeTimerRef = useRef<number | null>(null);
const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
```

3. Add the timer cleanup after the `useEffect` that loads projects (after line 55):

```tsx
useEffect(() => {
  return () => {
    if (removeTimerRef.current !== null) {
      window.clearTimeout(removeTimerRef.current);
    }
  };
}, []);
```

4. Add the handler after `loadMore`'s closing brace (after line 111):

```tsx
const handleDelete = useCallback(async () => {
  if (!deleteTarget || deleting) return;
  setDeleting(true);
  setDeleteError(null);
  try {
    await deleteUserDocument(deleteTarget.id);
    const deletedId = deleteTarget.id;
    setDeleteTarget(null);
    setPreviewDoc((prev) => (prev && prev.id === deletedId ? null : prev));
    setRemovingId(deletedId);
    removeTimerRef.current = window.setTimeout(() => {
      setItems((prev) => prev.filter((d) => d.id !== deletedId));
      setRemovingId((current) => (current === deletedId ? null : current));
      removeTimerRef.current = null;
    }, 200);
  } catch (error) {
    setDeleteError(
      error instanceof Error ? error.message : "Could not delete document",
    );
  } finally {
    setDeleting(false);
  }
}, [deleteTarget, deleting]);
```

5. Mark the removed row on the `<li>` (line 251):

```tsx
<li
  key={doc.id}
  className={removingId === doc.id ? "animate-fade-out" : undefined}
>
```

6. Replace the trailing full-width preview button (lines 261-270) with two icon buttons; the trash button records the trigger ref for focus restore:

```tsx
trailing={
  <div className="flex w-full items-center justify-end gap-1.5">
    <Button
      variant="ghost"
      size="icon"
      aria-label="Preview full content"
      title="Preview full content"
      onClick={() => setPreviewDoc(doc)}
    >
      <Eye className="size-4" strokeWidth={1.75} />
    </Button>
    <Button
      ref={deleteTriggerRef}
      variant="danger"
      size="icon"
      aria-label="Delete document"
      title="Delete document"
      onClick={() => setDeleteTarget(doc)}
    >
      <Trash2 className="size-4" strokeWidth={1.75} />
    </Button>
  </div>
}
```

Note: React 19 forwards `ref` as a regular prop — `Button` spreads `...rest` onto `<button>`, so `ref={deleteTriggerRef}` works with the Task 2 component unchanged. (A single `deleteTriggerRef` is enough for focus restore; per-row refs would be over-engineering.)

7. Add the `ConfirmDialog` next to `DocumentPreviewModal` (after line 300):

```tsx
<ConfirmDialog
  open={Boolean(deleteTarget)}
  title="Delete document?"
  description={
    deleteTarget
      ? `“${deleteTarget.filename}” and its embeddings will be permanently removed from your library.`
      : ""
  }
  confirmLabel="Delete document"
  busy={deleting}
  error={deleteError}
  restoreFocusRef={deleteTriggerRef}
  onCancel={() => {
    if (deleting) return;
    setDeleteTarget(null);
    setDeleteError(null);
  }}
  onConfirm={() => void handleDelete()}
/>
```

- [ ] **Step 5: Verify with typecheck + build**

Run: `pnpm --filter platform exec tsc --noEmit`
Expected: 0 errors, 0 warnings.
Run: `pnpm --filter platform build`
Expected: build succeeds.

- [ ] **Step 6: Manual smoke (dev servers)**

Run: `pnpm dev` (root; starts api + worker + platform). In the browser:
1. Open the Documents library page. Summary text shows max 2 lines with `…` at the end of line 2 — no half-cut third line.
2. Preview icon button (eye) opens the preview modal; hover/click shows the standard button transitions.
3. Trash icon button opens "Delete document?" dialog; Cancel closes it without changes and focus returns to the trash button.
4. Confirm: dialog closes immediately, the row fades out (≈160ms, `scale(0.98)` + opacity) then disappears; the group file-count updates. If the document was being previewed, the preview closes.
5. Failure path: temporarily stop the api (`pnpm dev:api` Ctrl+C) and confirm a delete — dialog stays open, inline danger error text appears (`role="alert"`), buttons re-enable; retry after restarting the api succeeds.
6. API check: `DELETE http://localhost:3001/api/documents/<id>?confirm=true` without confirm → 400 `CONFIRM_REQUIRED`; unknown id → 404 `DOCUMENT_NOT_FOUND`.
7. With OS reduced-motion on, no row animation plays (utility disabled via media query).

- [ ] **Step 7: Commit**

```bash
git add apps/platform/src/components/documents/document-row.tsx apps/platform/src/components/documents/documents-browser.tsx apps/platform/src/lib/api.ts apps/platform/src/styles.css
git commit -m "feat: library card icon actions, animated delete flow, and exact 2-line summary clamp"
```

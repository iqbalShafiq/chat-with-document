import { useRef, useState, type RefObject } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import {
  DIALOG_PRIMARY_BUTTON_CLASS,
  DIALOG_SECONDARY_BUTTON_CLASS,
} from "#/components/ui/dialog-actions";
import { DialogShell } from "#/components/ui/dialog-shell";
import { FormTextField } from "#/components/ui/form-field";
import { PopoverMenu } from "#/components/ui/popover-menu";
import { EMPTY_CHAT_TITLE, type SessionSummary } from "#/lib/session-history";

/**
 * Per-row session actions: hover-revealed "⋯" button (always visible on the
 * active row), floating action menu (rename / delete), rename form dialog and
 * delete confirm dialog.
 */
export function SessionActionsMenu({
  session,
  running,
  alwaysVisible = false,
  onRename,
  onDelete,
  onRemoved,
  restoreFocusRef,
  anchorRef,
}: {
  session: SessionSummary;
  running: boolean;
  /** Active row: keep the trigger visible without hover. */
  alwaysVisible?: boolean;
  /** Floating menu anchor; defaults to the "⋯" trigger button. */
  anchorRef?: RefObject<HTMLElement | null>;
  onRename: (sessionId: string, title: string) => Promise<void>;
  onDelete: (sessionId: string) => Promise<void>;
  /** Called after the exit animation so the parent can drop the row. */
  onRemoved: (sessionId: string) => void;
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const openRename = () => {
    setRenameValue(session.title === EMPTY_CHAT_TITLE ? "" : session.title);
    setRenameError(null);
    setRenameOpen(true);
  };

  const submitRename = async () => {
    if (renaming) return;
    const title = renameValue.trim();
    if (!title) {
      setRenameError("Give this chat a name");
      return;
    }
    setRenaming(true);
    setRenameError(null);
    try {
      await onRename(session.sessionId, title);
      setRenameOpen(false);
    } catch (error) {
      setRenameError(
        error instanceof Error ? error.message : "Could not rename chat",
      );
    } finally {
      setRenaming(false);
    }
  };

  const submitDelete = async () => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete(session.sessionId);
      setDeleteOpen(false);
      // The list plays the row's fade-out and then drops it via onRemoved.
      onRemoved(session.sessionId);
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : "Could not delete chat",
      );
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
        <button
          ref={buttonRef}
          type="button"
          aria-label={`Chat actions for ${session.title}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className={`inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-muted transition duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.08] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring active:scale-95 ${
            alwaysVisible || menuOpen
              ? "opacity-100"
              : "pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100"
          }`}
        >
          <MoreHorizontal className="size-4" strokeWidth={1.75} />
        </button>
      </div>

      <PopoverMenu
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorRef={anchorRef ?? buttonRef}
        align="start"
        floating
        floatingOffset={8}
        label="Chat actions"
        items={[
          {
            id: "rename",
            label: "Rename",
            icon: <Pencil className="size-3.5" strokeWidth={1.75} />,
            onSelect: openRename,
          },
          {
            id: "delete",
            label: "Delete",
            icon: <Trash2 className="size-3.5" strokeWidth={1.75} />,
            onSelect: () => {
              setDeleteError(null);
              setDeleteOpen(true);
            },
          },
        ]}
      />

      <DialogShell
        open={renameOpen}
        onClose={() => {
          if (renaming) return;
          setRenameOpen(false);
        }}
        title="Rename chat"
        description="Give this conversation a memorable name"
        size="sm"
        heightMode="content"
        dismissDisabled={renaming}
        initialFocusRef={nameInputRef}
        restoreFocusRef={restoreFocusRef ?? buttonRef}
        footer={
          <>
            <button
              type="button"
              disabled={renaming}
              onClick={() => setRenameOpen(false)}
              className={DIALOG_SECONDARY_BUTTON_CLASS}
            >
              Cancel
            </button>
            <button
              type="submit"
              form="rename-session-form"
              disabled={renaming || !renameValue.trim()}
              className={DIALOG_PRIMARY_BUTTON_CLASS}
            >
              {renaming ? "Saving…" : "Save"}
            </button>
          </>
        }
      >
        <form
          id="rename-session-form"
          className="flex flex-col gap-4 px-4 py-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submitRename();
          }}
        >
          <FormTextField
            ref={nameInputRef}
            label="Name"
            name="title"
            value={renameValue}
            onChange={(event) => {
              setRenameValue(event.target.value);
              if (renameError) setRenameError(null);
            }}
            placeholder="Give this chat a name…"
            autoComplete="off"
            maxLength={48}
            disabled={renaming}
            error={renameError}
          />
        </form>
      </DialogShell>

      <ConfirmDialog
        open={deleteOpen}
        title="Delete chat?"
        description={
          running
            ? "This conversation is still being processed. Deleting stops the run on every device, then permanently removes the conversation. Your documents and personalized preferences are not affected."
            : "This conversation and its messages will be permanently removed. Your documents and personalized preferences are not affected."
        }
        confirmLabel={deleting ? "Deleting…" : "Delete chat"}
        busy={deleting}
        error={deleteError}
        restoreFocusRef={restoreFocusRef ?? buttonRef}
        onCancel={() => {
          if (deleting) return;
          setDeleteOpen(false);
        }}
        onConfirm={() => void submitDelete()}
      />
    </>
  );
}

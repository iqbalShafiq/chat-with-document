import { useState } from "react";
import { Check, Loader2, Pencil } from "lucide-react";
import { updateImageCaption } from "#/lib/api-artifacts";

/** Inline caption editor for a single image asset. */
export function CaptionField({
  imageId,
  sessionId,
  caption,
  onSaved,
}: {
  imageId: string;
  sessionId: string;
  caption: string;
  onSaved?: (caption: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(caption);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5">
        <p className="min-w-0 flex-1 truncate text-[11px] text-text-muted">{caption}</p>
        <button
          type="button"
          aria-label="Edit caption"
          onClick={() => {
            setDraft(caption);
            setError(null);
            setEditing(true);
          }}
          className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-faint transition hover:bg-white/10 hover:text-text"
        >
          <Pencil className="size-3" />
        </button>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving || !draft.trim() || draft.length > 280) return;
        setSaving(true);
        setError(null);
        void updateImageCaption({ imageId, sessionId, caption: draft.trim() })
          .then((saved) => {
            setSaving(false);
            setEditing(false);
            onSaved?.(saved.caption);
          })
          .catch((saveError) => {
            setSaving(false);
            setError(saveError instanceof Error ? saveError.message : "Save failed");
          });
      }}
    >
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        type="text"
        value={draft}
        maxLength={280}
        disabled={saving}
        onChange={(event) => setDraft(event.target.value)}
        aria-label="Image caption"
        className="w-full rounded-lg border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[11px] text-text outline-none focus:border-accent/40 disabled:opacity-40"
      />
      {error ? (
        <p role="alert" className="text-[10px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={saving}
          onClick={() => setEditing(false)}
          className="h-6 cursor-pointer rounded-md px-2 text-[11px] text-text-muted hover:text-text disabled:opacity-40"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !draft.trim()}
          className="inline-flex h-6 cursor-pointer items-center gap-1 rounded-md bg-accent px-2 text-[11px] font-semibold text-canvas disabled:opacity-40"
        >
          {saving ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
          Save
        </button>
      </div>
    </form>
  );
}

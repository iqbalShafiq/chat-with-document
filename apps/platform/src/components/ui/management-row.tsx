import { Pencil, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Switch } from "#/components/ui/switch";

/**
 * Standard management list row: title + subtitle, a state switch, a
 * divider, and edit/delete icon actions. One rhythm for every settings-style
 * list (skills, MCP servers), matching the app's size-7 icon buttons and
 * the composer shell divider.
 */
export function ManagementRow({
  title,
  subtitle,
  leading,
  enabled,
  onToggle,
  toggleLabel,
  toggleTitle,
  toggleDisabled = false,
  onEdit,
  editLabel,
  onDelete,
  deleteLabel,
}: {
  title: string;
  subtitle?: string;
  leading?: ReactNode;
  enabled: boolean;
  onToggle: () => void;
  toggleLabel: string;
  toggleTitle?: string;
  toggleDisabled?: boolean;
  onEdit: () => void;
  editLabel: string;
  onDelete: () => void;
  deleteLabel: string;
}) {
  return (
    <li className="flex items-center gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5">
      {leading}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-text">{title}</p>
        {subtitle ? (
          <p className="truncate text-[11px] text-text-faint">{subtitle}</p>
        ) : null}
      </div>
      <Switch
        checked={enabled}
        onToggle={onToggle}
        label={toggleLabel}
        title={toggleTitle}
        disabled={toggleDisabled}
      />
      <span aria-hidden className="h-5 w-px shrink-0 bg-white/[0.08]" />
      <button
        type="button"
        aria-label={editLabel}
        title={editLabel}
        onClick={onEdit}
        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-muted transition duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.08] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring active:scale-95"
      >
        <Pencil className="size-4" strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label={deleteLabel}
        title={deleteLabel}
        onClick={onDelete}
        className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-faint transition duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-danger-soft hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring active:scale-95"
      >
        <Trash2 className="size-4" strokeWidth={1.75} />
      </button>
    </li>
  );
}

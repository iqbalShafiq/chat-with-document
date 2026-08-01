import { FileText } from "lucide-react";
import type { ReactNode } from "react";

export type DocumentRowProps = {
  filename: string;
  summary?: string | null;
  meta?: string | null;
  focused?: boolean;
  selected?: boolean;
  onClick?: () => void;
  trailing?: ReactNode;
  leading?: ReactNode;
  className?: string;
  title?: string;
  /**
   * Prefer "div" when trailing contains nested buttons (e.g. remove).
   * "button" is fine for simple selectable rows without nested controls.
   */
  as?: "div" | "button";
  "data-document-id"?: string;
};

/**
 * Shared glass document row for session rail + library list.
 */
export function DocumentRow({
  filename,
  summary,
  meta,
  focused = false,
  selected = false,
  onClick,
  trailing,
  leading,
  className = "",
  title,
  as = "div",
  "data-document-id": dataDocumentId,
}: DocumentRowProps) {
  const interactive = onClick != null;
  // Nested interactive children (remove / preview) are invalid inside <button>.
  const useNativeButton = as === "button" && interactive && !trailing;

  const shellClass = [
    "glass-pane flex w-full min-w-0 items-start gap-2.5 rounded-xl px-3 py-2.5 text-left text-xs text-text",
    "transition-[box-shadow,background-color] duration-200",
    focused
      ? "bg-accent-soft/40 ring-2 ring-accent-ring shadow-[0_0_0_1px_rgba(232,163,23,0.2)]"
      : "",
    selected ? "ring-1 ring-accent-ring/50 bg-accent-soft/20" : "",
    interactive
      ? "cursor-pointer hover:bg-white/[0.04] active:scale-[0.995]"
      : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  const content = (
    <>
      {leading ?? (
        <FileText
          className="mt-0.5 size-4 shrink-0 text-accent"
          strokeWidth={1.75}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="min-w-0 truncate font-medium leading-snug">{filename}</p>
        {meta ? (
          <p className="mt-0.5 text-[10px] text-text-faint">{meta}</p>
        ) : null}
        {summary ? (
          <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-text-faint">
            {summary}
          </p>
        ) : null}
      </div>
      {trailing ? (
        <div
          className="shrink-0"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {trailing}
        </div>
      ) : null}
    </>
  );

  if (useNativeButton) {
    return (
      <button
        type="button"
        className={shellClass}
        onClick={onClick}
        title={title ?? filename}
        data-document-id={dataDocumentId}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={shellClass}
      onClick={onClick}
      title={title ?? filename}
      data-document-id={dataDocumentId}
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
    >
      {content}
    </div>
  );
}

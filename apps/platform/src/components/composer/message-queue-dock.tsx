import {
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  EyeOff,
  GripVertical,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import type { QueuedItem } from "#/lib/chat/queued-messages";

function itemBadges(item: QueuedItem): string[] {
  const badges: string[] = [];
  const imageCount = item.attachments.filter(
    (attachment) => attachment.type === "image",
  ).length;
  if (imageCount > 0) badges.push(`+${imageCount} img`);
  const docCount =
    item.attachments.filter((attachment) => attachment.type !== "image").length +
    item.documentIds.length;
  if (docCount > 0) badges.push(`+${docCount} doc`);
  if (item.contextSnippet) badges.push("context");
  if (item.pinnedImageIds.length > 0) badges.push(`+${item.pinnedImageIds.length} pin`);
  return badges;
}

export function MessageQueueDock({
  items,
  onSendNow,
  onRemove,
  onReorder,
  onRecall,
  onCancelEdit,
}: {
  items: QueuedItem[];
  onSendNow: () => void;
  onRemove: (id: string) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRecall: (id: string) => void;
  onCancelEdit: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [hidden, setHidden] = useState(false);
  const dragIndexRef = useRef<number | null>(null);
  const hasPending = items.some((item) => item.status === "pending");

  if (items.length === 0) return null;

  if (hidden) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-1.5 text-xs text-text-muted animate-fade-in">
        <span className="font-medium">{items.length} queued</span>
        <button
          type="button"
          onClick={() => setHidden(false)}
          className="cursor-pointer rounded-md px-1.5 py-0.5 font-medium text-accent transition hover:bg-white/[0.06] active:scale-[0.97]"
        >
          Show
        </button>
      </div>
    );
  }

  const visibleItems = expanded ? items : items.slice(0, 1);
  const showLoadMore = !expanded && items.length > 1;

  return (
    <div
      role="list"
      aria-label="Queued messages"
      className="flex flex-col gap-1.5 rounded-xl border border-white/[0.06] bg-white/[0.03] p-2 animate-fade-in"
    >
      <div
        className={`chat-scroll flex flex-col gap-1.5 overflow-y-auto overscroll-contain transition-[max-height] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          expanded ? "max-h-[9.75rem]" : "max-h-10"
        }`}
      >
        {visibleItems.map((item, index) => {
          const editing = item.status === "editing";
          const badges = itemBadges(item);
          return (
            <div
              key={item.id}
              role="listitem"
              draggable={expanded && !editing}
              onDragStart={(event) => {
                dragIndexRef.current = index;
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const from = dragIndexRef.current;
                dragIndexRef.current = null;
                if (from !== null && from !== index) onReorder(from, index);
              }}
              onDragEnd={() => {
                dragIndexRef.current = null;
              }}
              className={`group/queue-item flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs transition duration-150 ${
                editing
                  ? "border-white/[0.05] bg-white/[0.02] text-text-muted"
                  : "border-white/[0.06] bg-white/[0.03] text-text"
              }`}
            >
              {expanded && !editing ? (
                <button
                  type="button"
                  aria-label={`Reorder "${item.text}"`}
                  title="Drag to reorder"
                  className="cursor-grab text-text-faint transition hover:text-text-muted active:cursor-grabbing"
                >
                  <GripVertical className="size-3.5" strokeWidth={1.75} />
                </button>
              ) : (
                <span className="w-3.5 shrink-0" aria-hidden />
              )}
              <button
                type="button"
                disabled={editing}
                onClick={() => onRecall(item.id)}
                title={editing ? "Being edited" : "Click to edit"}
                className="min-w-0 flex-1 cursor-pointer truncate text-left disabled:cursor-default"
              >
                <span className={editing ? "italic" : ""}>
                  {editing ? "editing…" : item.text || "(image message)"}
                </span>
                {badges.length > 0 ? (
                  <span className="ml-1.5 text-[10px] font-medium text-text-faint">
                    {badges.join(" · ")}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                aria-label={editing ? "Cancel edit" : `Remove "${item.text}"`}
                title={editing ? "Cancel edit" : "Remove"}
                onClick={() => (editing ? onCancelEdit(item.id) : onRemove(item.id))}
                className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-faint transition hover:bg-white/[0.06] hover:text-text active:scale-[0.96]"
              >
                <X className="size-3.5" strokeWidth={2} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-1.5">
        <div className="flex min-w-0 items-center gap-1">
          {showLoadMore ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] font-medium text-text-muted transition hover:bg-white/[0.06] hover:text-text active:scale-[0.97]"
            >
              load more ({items.length - 1})
            </button>
          ) : null}
          {expanded ? (
            <button
              type="button"
              aria-label="Collapse queue"
              title="Collapse"
              onClick={() => setExpanded(false)}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-text-muted transition hover:bg-white/[0.06] hover:text-text active:scale-[0.96]"
            >
              <ChevronUp className="size-3.5" strokeWidth={2} />
            </button>
          ) : null}
          {!expanded ? (
            <button
              type="button"
              aria-label="Expand queue"
              title="Expand"
              onClick={() => setExpanded(true)}
              className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-text-muted transition hover:bg-white/[0.06] hover:text-text active:scale-[0.96]"
            >
              <ChevronDown className="size-3.5" strokeWidth={2} />
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Hide queue"
            title="Hide"
            onClick={() => setHidden(true)}
            className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-text-muted transition hover:bg-white/[0.06] hover:text-text active:scale-[0.96]"
          >
            <EyeOff className="size-3.5" strokeWidth={1.75} />
          </button>
        </div>
        {hasPending ? (
          <button
            type="button"
            onClick={onSendNow}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-[11px] font-semibold text-canvas shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-accent-hover active:scale-[0.97]"
          >
            <CornerDownLeft className="size-3.5" strokeWidth={2.25} />
            Send now
          </button>
        ) : null}
      </div>
    </div>
  );
}

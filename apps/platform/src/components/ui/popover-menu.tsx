import {
  useEffect,
  useId,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

export type PopoverMenuItem = {
  id: string;
  label: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
};

export type PopoverMenuProps = {
  open: boolean;
  onClose: () => void;
  items: PopoverMenuItem[];
  /** Anchor element used for outside-click exclusion. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Positioning class (absolute/fixed). Default opens above-left of relative parent. */
  className?: string;
  align?: "start" | "end";
  label?: string;
};

/**
 * Lightweight action menu (not auto-dismiss feedback).
 * Parent should be `relative`; menu positions with absolute bottom/top.
 */
export function PopoverMenu({
  open,
  onClose,
  items,
  anchorRef,
  className = "",
  align = "end",
  label = "Menu",
}: PopoverMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;

    const handlePointer = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    document.addEventListener("pointerdown", handlePointer, true);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer, true);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={menuRef}
      id={listId}
      role="menu"
      aria-label={label}
      className={`absolute bottom-full z-30 mb-1.5 min-w-[12.5rem] overflow-hidden rounded-xl border border-white/[0.08] bg-canvas-elevated py-0 text-text shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)] animate-fade-in ${
        align === "end" ? "right-0" : "left-0"
      } ${className}`}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            if (item.disabled) return;
            item.onSelect();
            onClose();
          }}
          className="flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left transition duration-150 hover:bg-white/[0.06] focus-visible:bg-white/[0.08] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
        >
          {item.icon ? (
            <span className="mt-0.5 shrink-0 text-text-muted">{item.icon}</span>
          ) : null}
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs font-medium text-text">{item.label}</span>
            {item.description ? (
              <span className="text-[10px] leading-snug text-text-faint">
                {item.description}
              </span>
            ) : null}
          </span>
        </button>
      ))}
    </div>
  );
}

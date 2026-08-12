import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

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
  /**
   * Portal + fixed positioning to the RIGHT of the anchor. Required inside
   * overflow-clipping containers (e.g. the sidebar's scroll area). Closes on
   * any scroll and flips above when the viewport bottom is too close.
   */
  floating?: boolean;
  /** Gap between the anchor's right edge and the menu (floating only). */
  floatingOffset?: number;
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
  floating = false,
  floatingOffset = 8,
}: PopoverMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

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

  useLayoutEffect(() => {
    if (!open || !floating) return;

    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuHeight =
        menuRef.current?.getBoundingClientRect().height ?? 140;
      const spaceBelow = window.innerHeight - rect.top;
      const top =
        spaceBelow >= menuHeight + 16
          ? rect.top
          : Math.max(8, rect.bottom - menuHeight);
      setPosition({ left: rect.right + floatingOffset, top });
    };

    update();

    const onScroll = () => onClose();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", update);
    };
  }, [open, floating, onClose, anchorRef, floatingOffset]);

  if (!open) return null;

  const menuItems = items.map((item) => (
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
  ));

  if (floating) {
    return createPortal(
      <div
        ref={menuRef}
        id={listId}
        role="menu"
        aria-label={label}
        className="glass-popover fixed z-50 min-w-[12.5rem] overflow-hidden rounded-xl py-0 text-text shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)] animate-scale-in"
        style={position ?? { left: -9999, top: -9999 }}
      >
        {menuItems}
      </div>,
      document.body,
    );
  }

  return (
    <div
      ref={menuRef}
      id={listId}
      role="menu"
      aria-label={label}
      className={`glass-popover absolute bottom-full z-30 mb-1.5 min-w-[12.5rem] overflow-hidden rounded-xl py-0 text-text shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)] animate-fade-in ${
        align === "end" ? "right-0" : "left-0"
      } ${className}`}
    >
      {menuItems}
    </div>
  );
}

import { ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  SelectOptionList,
  type SelectOption,
} from "#/components/ui/select-list";

export type SelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  leadingIcon?: ReactNode;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
  /**
   * Hover detail placement for option cards (model logos etc).
   */
  hoverSide?: "top" | "right";
};

type ListPos = {
  top: number;
  left: number;
  width: number;
  /** Open above the trigger (composer / bottom-of-viewport). */
  openUp: boolean;
};

export function Select({
  value,
  onChange,
  options,
  leadingIcon,
  ariaLabel,
  className = "",
  disabled = false,
  hoverSide = "top",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const wasOpenRef = useRef(false);
  /**
   * Native `showModal()` dialogs live in the browser top layer, so a listbox
   * portaled to `document.body` renders *behind* the modal. Detect a dialog
   * ancestor after commit and portal the list INTO the dialog instead.
   * Outside dialogs we always portal to `document.body` so overflow / sibling
   * stacking (e.g. approval card above the composer) cannot clip the menu.
   */
  const [dialogPortal, setDialogPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setDialogPortal(rootRef.current?.closest("dialog") ?? null);
  }, []);

  const selected = options.find((opt) => opt.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      // The portaled listbox lives outside the root — clicks on it must not
      // close the dropdown before the option's onClick fires.
      if (listRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    // Defer so the opening click does not immediately close.
    const timer = window.setTimeout(() => {
      document.addEventListener("mousedown", onPointerDown);
      document.addEventListener("keydown", onKeyDown);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  const [listPos, setListPos] = useState<ListPos | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      setListPos(null);
      return;
    }

    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const gap = 6;
      // Match max-h-[16rem] on the list — used only to pick open direction.
      const estimatedListH = Math.min(options.length * 44 + 8, 16 * 16);
      const spaceBelow = window.innerHeight - rect.bottom - gap;
      const spaceAbove = rect.top - gap;
      const openUp =
        spaceBelow < Math.min(estimatedListH, 160) && spaceAbove > spaceBelow;

      const width = Math.max(rect.width, 200);
      const maxLeft = window.innerWidth - width - 8;
      const leftViewport = Math.max(8, Math.min(rect.left, maxLeft));

      if (dialogPortal) {
        // Coords relative to the dialog box (list is portaled into it).
        const targetRect = dialogPortal.getBoundingClientRect();
        setListPos({
          top: openUp
            ? rect.top - gap - targetRect.top
            : rect.bottom + gap - targetRect.top,
          left: leftViewport - targetRect.left,
          width,
          openUp,
        });
        return;
      }

      setListPos({
        top: openUp ? rect.top - gap : rect.bottom + gap,
        left: leftViewport,
        width,
        openUp,
      });
    };

    update();
    window.addEventListener("resize", update);
    // Capture scroll from any ancestor (chat viewport, approval dock, etc.)
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, dialogPortal, options.length]);

  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const selectedButton = list.querySelector<HTMLButtonElement>(
      'li[aria-selected="true"] button',
    );
    const firstButton = list.querySelector<HTMLButtonElement>(
      "button[data-option-value]",
    );
    (selectedButton ?? firstButton)?.focus();
  }, [open]);

  const moveFocus = (index: number, direction: 1 | -1) => {
    const list = listRef.current;
    if (!list) return;
    const buttons = Array.from(
      list.querySelectorAll<HTMLButtonElement>("button[data-option-value]"),
    );
    if (buttons.length === 0) return;
    let i = index;
    for (let step = 0; step < buttons.length; step += 1) {
      const button = buttons[i];
      if (button && !button.disabled) {
        button.focus();
        return;
      }
      i = (i + direction + buttons.length) % buttons.length;
    }
  };

  const handleListKeyDown = (event: KeyboardEvent) => {
    const list = listRef.current;
    if (!list) return;
    const buttons = Array.from(
      list.querySelectorAll<HTMLButtonElement>("button[data-option-value]"),
    );
    if (buttons.length === 0) return;
    const currentIndex = buttons.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        moveFocus(currentIndex + 1, 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        moveFocus(currentIndex - 1, -1);
        break;
      case "Home":
        event.preventDefault();
        moveFocus(0, 1);
        break;
      case "End":
        event.preventDefault();
        moveFocus(buttons.length - 1, -1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        (document.activeElement as HTMLButtonElement | null)?.click();
        break;
    }
  };

  const portalTarget = dialogPortal ?? (typeof document !== "undefined" ? document.body : null);

  const listbox =
    open && listPos && portalTarget
      ? createPortal(
          <div
            className="fixed z-[90]"
            style={{
              top: listPos.top,
              left: listPos.left,
              width: listPos.width,
              transform: listPos.openUp ? "translateY(-100%)" : undefined,
            }}
          >
            <SelectOptionList
              ref={listRef}
              id={listId}
              ariaLabel={ariaLabel}
              value={value}
              options={options}
              onSelect={(optionValue) => {
                onChange(optionValue);
                setOpen(false);
              }}
              onKeyDown={handleListKeyDown}
              hoverSide={hoverSide}
              className="max-h-[16rem] overflow-y-auto"
            />
          </div>,
          portalTarget,
        )
      : null;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {leadingIcon ? (
        <span className="pointer-events-none absolute left-3 top-1/2 z-10 flex -translate-y-1/2 items-center text-text-faint">
          {leadingIcon}
        </span>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={selected ? `${ariaLabel}, ${selected.label}` : ariaLabel}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`w-full cursor-pointer rounded-xl bg-white/[0.04] py-2.5 text-left text-sm text-text outline-none ring-1 ring-white/[0.08] transition focus:bg-white/[0.055] focus:ring-2 focus:ring-accent-ring disabled:cursor-not-allowed disabled:opacity-40 ${
          leadingIcon ? "pl-10" : "pl-3"
        } pr-9`}
      >
        {selected?.label ?? "Select…"}
      </button>
      <ChevronDown
        className={`pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-text-faint transition-transform duration-200 ${
          open ? "rotate-180" : ""
        }`}
        strokeWidth={1.75}
      />
      {listbox}
    </div>
  );
}

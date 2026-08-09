import { ChevronDown } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
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
};

export function Select({
  value,
  onChange,
  options,
  leadingIcon,
  ariaLabel,
  className = "",
  disabled = false,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listId = useId();
  const wasOpenRef = useRef(false);

  const selected = options.find((opt) => opt.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
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
      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1.5">
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
            className="max-h-[16rem] overflow-y-auto"
          />
        </div>
      ) : null}
    </div>
  );
}

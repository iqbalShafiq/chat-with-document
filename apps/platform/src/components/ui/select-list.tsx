import type {
  CSSProperties,
  KeyboardEventHandler,
  ReactNode,
  Ref,
} from "react";
import { HoverCard } from "#/components/ui/hover-card";

export type SelectOption = {
  value: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Extra capability/price info shown as a hover popover on the row. */
  detail?: ReactNode;
};

export type SelectOptionListProps = {
  ref?: Ref<HTMLUListElement>;
  id: string;
  ariaLabel: string;
  value: string;
  options: SelectOption[];
  onSelect: (value: string) => void;
  style?: CSSProperties;
  className?: string;
  onKeyDown?: KeyboardEventHandler;
  /** Where the option detail hover card appears relative to the popover. */
  hoverSide?: "top" | "right";
};

/**
 * Presentational listbox panel shared by Select and the model/reasoning
 * switcher. Open/close and keyboard logic live in the caller.
 */
export function SelectOptionList({
  ref,
  id,
  ariaLabel,
  value,
  options,
  onSelect,
  style,
  className = "",
  onKeyDown,
  hoverSide = "top",
}: SelectOptionListProps) {
  return (
    <ul
      ref={ref}
      id={id}
      role="listbox"
      aria-label={ariaLabel}
      style={style}
      onKeyDown={onKeyDown}
      className={`chat-scroll overflow-hidden rounded-xl border border-white/[0.08] bg-canvas-elevated text-text shadow-[0_12px_40px_-12px_rgba(0,0,0,0.75)] animate-fade-in ${className}`}
    >
      {options.map((opt) => {
        const isSelected = opt.value === value;
        const row = (
          <button
            type="button"
            disabled={opt.disabled}
            data-option-value={opt.value}
            className={`flex w-full cursor-pointer items-start gap-2 px-3 py-2 text-left transition duration-150 hover:bg-white/[0.06] focus-visible:outline-none focus-visible:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40 ${
              isSelected ? "bg-white/[0.05]" : ""
            }`}
            onClick={() => {
              if (opt.disabled) return;
              onSelect(opt.value);
            }}
          >
            {opt.icon ? (
              <span className="mt-0.5 text-text-muted">{opt.icon}</span>
            ) : null}
            <span className="flex min-w-0 flex-col gap-0.5">
              <span
                className={`text-xs font-medium ${isSelected ? "text-text" : "text-text-muted"}`}
              >
                {opt.label}
              </span>
              {opt.hint ? (
                <span className="text-[10px] text-text-faint">
                  {opt.hint}
                </span>
              ) : null}
            </span>
          </button>
        );
        return (
          <li key={opt.value} role="option" aria-selected={isSelected}>
            {opt.detail ? (
              <HoverCard
                variant="tooltip"
                side={hoverSide}
                disabled={opt.disabled}
                content={opt.detail}
              >
                {row}
              </HoverCard>
            ) : (
              row
            )}
          </li>
        );
      })}
    </ul>
  );
}

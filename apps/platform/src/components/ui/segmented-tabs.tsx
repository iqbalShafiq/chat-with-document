import type { ReactNode } from "react";

export type SegmentedTabOption<T extends string> = {
  value: T;
  label: string;
  /** Optional trailing adornment (e.g. a count badge). */
  badge?: ReactNode;
};

/**
 * Segmented tab switcher: one rhythm for tabbed switching anywhere
 * (task modal, artifact rail). Always keyboard-focusable buttons with
 * pointer cursor, selected state in accent, rest muted with hover.
 */
export function SegmentedTabs<T extends string>({
  label,
  value,
  onSelect,
  options,
}: {
  label: string;
  value: T;
  onSelect: (value: T) => void;
  options: Array<SegmentedTabOption<T>>;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onSelect(option.value)}
            className={
              selected
                ? "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 text-[11px] font-medium capitalize text-accent transition duration-150 hover:bg-accent/15 active:scale-[0.97]"
                : "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.04] px-2.5 text-[11px] font-medium capitalize text-text-muted transition duration-150 hover:bg-white/10 hover:text-text active:scale-[0.97]"
            }
          >
            {option.label}
            {option.badge}
          </button>
        );
      })}
    </div>
  );
}

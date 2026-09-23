/**
 * Standard toggle switch (shadcn/Radix anatomy, our compact size).
 *
 * Geometry is load-bearing: 28x16 track, 12px knob, 2px outer insets,
 * 14px travel (`translate-x-3.5`). The knob is pinned with `left-0` — never
 * rely on static position plus translate alone: measured in-browser, the
 * unpinned knob renders fully outside the track.
 */
export function Switch({
  checked,
  onToggle,
  label,
  title,
  disabled = false,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onToggle}
      className={`relative h-4 w-7 shrink-0 cursor-pointer rounded-full transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:cursor-not-allowed disabled:opacity-40 ${checked ? "bg-accent/80" : "bg-white/12"}`}
    >
      <span
        aria-hidden
        className={`absolute left-0 top-0.5 size-3 rounded-full bg-white shadow-sm transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${checked ? "translate-x-3.5" : "translate-x-0.5"}`}
      />
    </button>
  );
}

export function CountBadge({
  count,
  label,
  tone = "neutral",
}: {
  count: number;
  label: string;
  tone?: "neutral" | "accent";
}) {
  if (!Number.isFinite(count) || count <= 0) return null;
  const palette =
    tone === "accent" ? "bg-accent/20 text-accent" : "bg-white/[0.08] text-text-muted";
  if (count > 99) {
    return (
      <span
        aria-label={`${count} ${label}`}
        className={`inline-flex min-h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${palette}`}
      >
        99+
      </span>
    );
  }
  return (
    <span
      aria-label={`${count} ${label}`}
      className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums ${palette}`}
    >
      {count}
    </span>
  );
}

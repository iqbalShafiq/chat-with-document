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
  return (
    <span
      aria-label={`${count} ${label}`}
      className={`inline-flex min-h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${tone === "accent" ? "bg-accent/20 text-accent" : "bg-white/[0.08] text-text-muted"}`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

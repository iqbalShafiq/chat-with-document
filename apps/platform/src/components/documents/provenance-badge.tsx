export type DocumentOrigin = "upload" | "created" | "fetched" | string;

export function ProvenanceBadge({
  origin,
  title,
}: {
  origin?: DocumentOrigin | null;
  title?: string | null;
}) {
  if (origin !== "created" && origin !== "fetched") return null;
  const label = origin === "created" ? "Olahan" : "Unduhan";
  return (
    <span
      title={title ?? label}
      className="shrink-0 rounded-full border border-white/[0.08] bg-white/[0.05] px-1.5 py-px text-[9px] font-semibold uppercase tracking-[0.08em] text-text-muted"
    >
      {label}
    </span>
  );
}

export function provenanceTitle(input: {
  origin?: DocumentOrigin | null;
  parentFilename?: string | null;
  originUrl?: string | null;
  sourceNote?: string | null;
}): string | null {
  if (input.origin === "fetched") {
    return input.originUrl ? `Downloaded from ${input.originUrl}` : "Downloaded from URL";
  }
  if (input.origin === "created") {
    if (input.parentFilename) return `Derived from ${input.parentFilename}`;
    if (input.sourceNote) return input.sourceNote;
    return "Created by the assistant";
  }
  return null;
}

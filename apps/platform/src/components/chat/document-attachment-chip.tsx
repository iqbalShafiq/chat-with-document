import { FileText } from "lucide-react";

export function DocumentAttachmentChip({
  name,
  mediaType,
}: {
  name: string;
  mediaType?: string;
}) {
  return (
    <div
      className="inline-flex min-h-10 w-max max-w-[min(280px,75vw)] items-center gap-2 rounded-xl border border-accent/25 bg-accent-soft px-3 py-2 text-xs text-text"
      title={mediaType ? `${name} (${mediaType})` : name}
    >
      <FileText className="size-4 shrink-0 text-accent" strokeWidth={1.75} />
      <span className="truncate font-medium">{name}</span>
    </div>
  );
}

import { ScanSearch } from "lucide-react";

/** Shared DocChat brand glyph — same size/style in sidebar header & top bar. */
export function DocChatMark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent ${className}`}
    >
      <ScanSearch className="size-4" strokeWidth={1.75} />
    </span>
  );
}

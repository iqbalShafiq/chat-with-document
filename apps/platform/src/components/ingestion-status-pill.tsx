import type { DocumentStatus } from "#/lib/api";
import { ingestionStatusLabel } from "#/lib/api";
import { Loader2 } from "lucide-react";

export function IngestionStatusPill({
  filename,
  status,
}: {
  filename: string;
  status: DocumentStatus;
}) {
  const isReady = status === "ready";
  const isFailed = status === "failed";

  return (
    <div
      className={`inline-flex min-h-11 w-full items-center gap-2 rounded-xl border px-3 py-2 text-xs ${
        isFailed
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : isReady
            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : "border-zinc-200 bg-zinc-50 text-zinc-700"
      }`}
    >
      {!isReady && !isFailed ? (
        <Loader2 className="size-4 shrink-0 animate-spin" strokeWidth={1.75} />
      ) : null}
      <span className="truncate font-medium">{filename}</span>
      <span className="ml-auto shrink-0">{ingestionStatusLabel(status)}</span>
    </div>
  );
}

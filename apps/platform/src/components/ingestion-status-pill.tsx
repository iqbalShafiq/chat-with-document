import type { DocumentStatus } from "#/lib/api";
import { ingestionStatusLabel } from "#/lib/api";
import { FileText, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

function useElapsedSeconds() {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setElapsed((prev) => prev + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  return elapsed;
}

function formatElapsed(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function IngestionStatusPill({
  filename,
  status,
}: {
  filename: string;
  status: DocumentStatus;
}) {
  const isReady = status === "ready";
  const isFailed = status === "failed";
  const isPending = !isReady && !isFailed;
  const elapsed = useElapsedSeconds();

  return (
    <div
      className={`inline-flex min-h-11 w-max max-w-[min(320px,80vw)] shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-xs ${
        isFailed
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : isReady
            ? "border-emerald-200 bg-emerald-50 text-emerald-800"
            : "border-zinc-200 bg-zinc-50 text-zinc-700"
      }`}
      title={`${filename} — ${ingestionStatusLabel(status)}`}
    >
      {isPending ? (
        <Loader2 className="size-4 shrink-0 animate-spin" strokeWidth={1.75} />
      ) : (
        <FileText
          className={`size-4 shrink-0 ${isFailed ? "text-rose-600" : "text-emerald-700"}`}
          strokeWidth={1.75}
        />
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium">{filename}</span>
        <span className={`text-[10px] leading-tight ${isPending ? "text-zinc-500" : isFailed ? "text-rose-500" : "text-emerald-600"}`}>
          {ingestionStatusLabel(status)}
          {isPending ? ` · ${formatElapsed(elapsed)}` : null}
        </span>
      </div>
    </div>
  );
}

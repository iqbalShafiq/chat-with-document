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
      className={`inline-flex min-h-10 w-max max-w-[min(320px,80vw)] shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-xs ${
        isFailed
          ? "border-danger/30 bg-danger-soft text-danger"
          : isReady
            ? "border-accent/25 bg-accent-soft text-text"
            : "border-hairline bg-surface text-text-muted"
      }`}
      title={`${filename} — ${ingestionStatusLabel(status)}`}
    >
      {isPending ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-accent" strokeWidth={1.75} />
      ) : (
        <FileText
          className={`size-4 shrink-0 ${isFailed ? "text-danger" : "text-accent"}`}
          strokeWidth={1.75}
        />
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate font-medium text-text">{filename}</span>
        <span
          className={`text-[10px] leading-tight ${
            isPending
              ? "text-text-faint"
              : isFailed
                ? "text-danger/80"
                : "text-accent"
          }`}
        >
          {ingestionStatusLabel(status)}
          {isPending ? ` · ${formatElapsed(elapsed)}` : null}
        </span>
      </div>
    </div>
  );
}

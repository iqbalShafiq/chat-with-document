import { useChatContext, useMessage, useMessagePart } from "@anvia/react-ui";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "#/components/math-markdown";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100) / 10)}s`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

/**
 * UI shows only reasoning summary text (Anvia maps that to part.text).
 * Encrypted reasoning stays in server/memory payloads, never rendered here.
 */
export function ReasoningPanel({
  isStreamingMessage,
}: {
  isStreamingMessage: boolean;
}) {
  const { part } = useMessagePart();
  const { message } = useMessage();
  const chat = useChatContext();
  const panelId = useId();

  const startedAtRef = useRef<number | null>(null);
  const wasLiveRef = useRef(false);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [open, setOpen] = useState(true);
  const userToggledRef = useRef(false);

  const partIndex = message.parts.findIndex((p) => p.id === part.id);
  const laterParts = message.parts.slice(partIndex + 1);
  const hasFollowUp = laterParts.some(
    (p) => p.type === "tool" || p.type === "text" || p.type === "reasoning",
  );

  const isLive =
    isStreamingMessage && chat.status === "streaming" && !hasFollowUp;

  const summaryText =
    part.type === "reasoning" ? part.text.trim() : "";
  const hasSummary = summaryText.length > 0;

  useEffect(() => {
    if (part.type !== "reasoning") return;

    if (isLive) {
      if (startedAtRef.current === null) {
        startedAtRef.current = Date.now();
      }
      wasLiveRef.current = true;
      setElapsedMs(null);
      if (!userToggledRef.current) setOpen(true);
      return;
    }

    if (wasLiveRef.current && startedAtRef.current !== null) {
      setElapsedMs(Date.now() - startedAtRef.current);
      wasLiveRef.current = false;
      if (!userToggledRef.current) setOpen(false);
    }
  }, [isLive, part.id, part.type]);

  const label = useMemo(() => {
    if (isLive) return "Thinking…";
    if (elapsedMs !== null) return `Thought for ${formatDuration(elapsedMs)}`;
    return "Thought for a moment";
  }, [elapsedMs, isLive]);

  if (part.type !== "reasoning") return null;

  return (
    <div
      className={`overflow-hidden rounded-xl border text-xs ${
        isLive
          ? "border-violet-200 bg-violet-50 text-violet-800"
          : "border-violet-100 bg-violet-50/70 text-violet-700"
      }`}
      data-reasoning-state={isLive ? "live" : "done"}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          userToggledRef.current = true;
          setOpen((current) => !current);
        }}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition hover:bg-violet-100/40 active:scale-[0.995]"
      >
        <ChevronDown
          className={`size-3.5 shrink-0 opacity-70 transition-transform duration-200 ${
            open ? "rotate-0" : "-rotate-90"
          }`}
          strokeWidth={2}
        />
        <span className="min-w-0 flex-1 font-medium tracking-tight">{label}</span>
      </button>

      <div
        id={panelId}
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none ${
          open
            ? "grid-rows-[1fr] opacity-100"
            : "pointer-events-none grid-rows-[0fr] opacity-0"
        }`}
        aria-hidden={!open}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="border-t border-violet-200/60 px-3 py-2">
            {hasSummary ? (
              <div className="reasoning-summary opacity-90 [&_a]:text-violet-900 [&_a]:underline [&_code]:rounded [&_code]:bg-violet-100/80 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_li]:my-0.5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_p+p]:mt-2 [&_strong]:font-semibold [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4">
                <MarkdownBody content={summaryText} />
              </div>
            ) : (
              <p className="opacity-70">
                {isLive ? "Waiting for summary…" : "No summary available."}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

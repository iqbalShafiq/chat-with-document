import { useChatContext, useMessage, useMessagePart } from "@anvia/react-ui";
import { ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { MarkdownBody } from "#/components/math-markdown";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms / 100) / 10)}s`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

/**
 * Flat collapsible reasoning — no card chrome.
 * UI shows only reasoning summary text (Anvia maps that to part.text).
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

  const summaryText = part.type === "reasoning" ? part.text.trim() : "";
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
      className="text-xs text-text-muted"
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
        className="group/activity inline-flex max-w-full cursor-pointer items-center gap-1.5 py-0.5 text-left transition-colors duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:text-text active:scale-[0.99]"
      >
        <ChevronDown
          className={`size-3.5 shrink-0 text-text-faint transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/activity:text-text-muted ${
            open ? "rotate-0" : "-rotate-90"
          }`}
          strokeWidth={2}
        />
        {isLive ? (
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-accent"
            strokeWidth={2}
          />
        ) : null}
        <span
          className={`min-w-0 truncate font-medium tracking-tight ${
            isLive ? "text-text" : "text-text-muted group-hover/activity:text-text"
          }`}
        >
          {label}
        </span>
      </button>

      {open ? (
        <div id={panelId} className="mt-1.5 border-l border-white/[0.08] pl-3 ml-1.5 animate-fade-in">
          {hasSummary ? (
            <div className="reasoning-summary text-[12px] leading-relaxed text-text-muted [&_a]:text-accent [&_a]:underline [&_code]:rounded [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_li]:my-0.5 [&_ol]:my-1.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_p+p]:mt-2 [&_strong]:font-semibold [&_strong]:text-text/90 [&_ul]:my-1.5 [&_ul]:list-disc [&_ul]:pl-4">
              <MarkdownBody content={summaryText} />
            </div>
          ) : (
            <p className="text-[12px] text-text-faint">
              {isLive ? "Waiting for summary…" : "No summary available."}
            </p>
          )}
        </div>
      ) : (
        <div id={panelId} hidden />
      )}
    </div>
  );
}

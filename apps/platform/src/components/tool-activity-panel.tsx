import type { UIMessagePart } from "@anvia/react";
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  formatToolInput,
  formatToolOutput,
  parseToolValue,
  type FormattedSection,
} from "#/components/tool-io-format";

const TOOL_LABELS: Record<string, string> = {
  find_documents: "Finding documents",
  search_document_pages: "Searching document pages",
  get_document_next_page: "Reading next page",
  descriptive_stats: "Computing statistics",
  pearson_correlation: "Computing correlation",
  linear_regression: "Fitting regression",
};

type ToolPart = Extract<UIMessagePart, { type: "tool" }>;

export function getToolActivityLabel(part: ToolPart) {
  return TOOL_LABELS[part.toolName] ?? `Running ${part.toolName}`;
}

function statusLabel(part: ToolPart) {
  if (part.state === "error") return "Error";
  if (part.state === "output-available") return "Completed";
  return "Working…";
}

function ToolSectionView({ section }: { section: FormattedSection }) {
  const hasFields = (section.fields?.length ?? 0) > 0;
  const hasItems = (section.items?.length ?? 0) > 0;

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold tracking-wide uppercase opacity-70">
        {section.title}
      </p>
      {section.summary ? (
        <p className="font-medium opacity-95">{section.summary}</p>
      ) : null}
      {hasFields ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
          {section.fields!.map((field) => (
            <div
              key={`${section.title}-${field.label}`}
              className="contents"
            >
              <dt className="font-medium whitespace-nowrap opacity-70">
                {field.label}
              </dt>
              <dd className="min-w-0 break-words opacity-95">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {hasItems ? (
        <ul className="space-y-2">
          {section.items!.map((item, index) => (
            <li
              key={`${section.title}-${item.title}-${index}`}
              className="rounded-lg border border-hairline bg-surface px-2.5 py-1.5"
            >
              <p className="font-medium opacity-95">{item.title}</p>
              {item.meta ? (
                <p className="mt-0.5 text-[11px] opacity-70">{item.meta}</p>
              ) : null}
              {item.detail ? (
                <p className="mt-1 text-[11px] leading-relaxed opacity-80">
                  {item.detail}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!section.summary && !hasFields && !hasItems && section.emptyText ? (
        <p className="opacity-70">{section.emptyText}</p>
      ) : null}
    </div>
  );
}

export function ToolActivityPanel({ part }: { part: ToolPart }) {
  const label = getToolActivityLabel(part);
  const isRunning =
    part.state === "input-streaming" || part.state === "input-available";
  const isError = part.state === "error";
  const isDone = part.state === "output-available";

  const panelId = useId();
  const [open, setOpen] = useState(() => isRunning || isError);
  const userToggledRef = useRef(false);
  const previousStateRef = useRef(part.state);

  useEffect(() => {
    userToggledRef.current = false;
    previousStateRef.current = part.state;
    setOpen(
      part.state === "input-streaming" ||
        part.state === "input-available" ||
        part.state === "error",
    );
  }, [part.id]);

  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = part.state;

    if (userToggledRef.current) return;

    const wasRunning =
      previous === "input-streaming" || previous === "input-available";
    if (wasRunning && isDone) {
      setOpen(false);
      return;
    }
    if (isRunning || isError) {
      setOpen(true);
    }
  }, [part.state, isRunning, isError, isDone]);

  const requestSection = useMemo(() => {
    return formatToolInput(part.toolName, parseToolValue(part.input));
  }, [part.toolName, part.input]);

  const resultSection = useMemo(() => {
    if (isError) {
      return {
        title: "Error",
        fields: [
          {
            label: "Message",
            value: part.error?.message ?? "Tool failed",
          },
        ],
      } satisfies FormattedSection;
    }
    if (isRunning) {
      return {
        title: "Result",
        emptyText: "Working…",
      } satisfies FormattedSection;
    }
    return formatToolOutput(part.toolName, parseToolValue(part.output));
  }, [isError, isRunning, part.error?.message, part.output, part.toolName]);

  const toneClass = isError
    ? "border-danger/30 bg-danger-soft text-danger"
    : isRunning
      ? "border-accent/30 bg-accent-soft text-text"
      : "border-hairline bg-surface text-text-muted";

  return (
    <div className={`overflow-hidden rounded-xl border text-xs ${toneClass}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          userToggledRef.current = true;
          setOpen((current) => !current);
        }}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition hover:bg-surface-elevated active:scale-[0.995]"
      >
        <ChevronDown
          className={`size-3.5 shrink-0 opacity-70 transition-transform duration-200 ${
            open ? "rotate-0" : "-rotate-90"
          }`}
          strokeWidth={2}
        />
        <span className="min-w-0 flex-1 font-medium">{label}</span>
        <span className="shrink-0 text-[11px] opacity-80">{statusLabel(part)}</span>
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
          <div className="space-y-3 border-t border-current/10 px-3 py-2.5">
            <ToolSectionView section={requestSection} />
            <ToolSectionView section={resultSection} />
          </div>
        </div>
      </div>
    </div>
  );
}

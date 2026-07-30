import type { UIMessagePart } from "@anvia/react";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Loader2,
  Wrench,
} from "lucide-react";
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
  if (part.state === "output-available") return "Done";
  return "Working";
}

function ToolSectionView({ section }: { section: FormattedSection }) {
  const hasFields = (section.fields?.length ?? 0) > 0;
  const hasItems = (section.items?.length ?? 0) > 0;

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-faint">
        {section.title}
      </p>
      {section.summary ? (
        <p className="text-[12px] font-medium leading-relaxed text-text/90">
          {section.summary}
        </p>
      ) : null}
      {hasFields ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12px]">
          {section.fields!.map((field) => (
            <div key={`${section.title}-${field.label}`} className="contents">
              <dt className="font-medium whitespace-nowrap text-text-faint">
                {field.label}
              </dt>
              <dd className="min-w-0 break-words text-text/90">{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {hasItems ? (
        <ul className="space-y-1.5">
          {section.items!.map((item, index) => (
            <li
              key={`${section.title}-${item.title}-${index}`}
              className="activity-nested rounded-lg px-2.5 py-2"
            >
              <p className="text-[12px] font-medium text-text/90">{item.title}</p>
              {item.meta ? (
                <p className="mt-0.5 text-[11px] text-text-faint">{item.meta}</p>
              ) : null}
              {item.detail ? (
                <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                  {item.detail}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!section.summary && !hasFields && !hasItems && section.emptyText ? (
        <p className="text-[12px] text-text-faint">{section.emptyText}</p>
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

  const dataState = isError ? "error" : isRunning ? "live" : "done";

  const statusTone = isError
    ? "bg-danger-soft text-danger"
    : isRunning
      ? "bg-accent-soft text-accent"
      : "bg-white/[0.05] text-text-faint";

  const iconTone = isError
    ? "bg-danger-soft text-danger"
    : isRunning
      ? "bg-accent-soft text-accent"
      : "bg-white/[0.05] text-text-faint";

  return (
    <div
      className={`activity-card overflow-hidden rounded-xl text-xs ${
        isError ? "text-danger" : "text-text-muted"
      }`}
      data-state={dataState}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          userToggledRef.current = true;
          setOpen((current) => !current);
        }}
        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left transition hover:bg-white/[0.03] active:scale-[0.995]"
      >
        <span
          className={`inline-flex size-6 shrink-0 items-center justify-center rounded-lg ${iconTone}`}
        >
          {isError ? (
            <AlertCircle className="size-3.5" strokeWidth={1.75} />
          ) : isRunning ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
          ) : (
            <Wrench className="size-3.5" strokeWidth={1.75} />
          )}
        </span>

        <span className="min-w-0 flex-1 truncate font-medium tracking-tight text-text">
          {label}
        </span>

        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium tracking-wide ${statusTone}`}
        >
          {isDone && !isError ? (
            <Check className="size-3" strokeWidth={2.25} />
          ) : null}
          {statusLabel(part)}
        </span>

        <ChevronDown
          className={`size-3.5 shrink-0 text-text-faint transition-transform duration-200 ${
            open ? "rotate-0" : "-rotate-90"
          }`}
          strokeWidth={2}
        />
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
          <div className="activity-card-body space-y-3.5 px-3 py-2.5">
            <ToolSectionView section={requestSection} />
            <ToolSectionView section={resultSection} />
          </div>
        </div>
      </div>
    </div>
  );
}

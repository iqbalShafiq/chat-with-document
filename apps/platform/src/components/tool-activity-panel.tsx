import type { UIMessagePart } from "@anvia/react";
import { ChevronDown, Loader2 } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useImagePreview } from "#/components/images/image-preview";
import {
  isImageToolName,
  isMessageImageToolName,
} from "#/lib/chat/generated-images";
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
  get_document_page_images: "Inspecting page images",
  web_search: "Searching the web",
  web_fetch: "Fetching web page",
  generate_image: "Generating image",
  edit_image: "Editing image",
  view_image: "Viewing image",
  request_clarification: "Asking for clarification",
  "resolve-library-id": "Looking up library",
  "query-docs": "Reading library docs",
};

type ToolPart = Extract<UIMessagePart, { type: "tool" }>;

export function getToolActivityLabel(part: ToolPart) {
  return TOOL_LABELS[part.toolName] ?? `Running ${part.toolName}`;
}

/** Label for a bare tool name (e.g. approval cards) without a full part. */
export function toolActivityLabelForName(toolName: string) {
  return TOOL_LABELS[toolName] ?? `Running ${toolName}`;
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
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-text-faint">
        {section.title}
      </p>
      {section.summary ? (
        <p className="text-[12px] font-medium leading-relaxed text-text/90">
          {section.summary}
        </p>
      ) : null}
      {hasFields ? (
        <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
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
        <ul className="space-y-2">
          {section.items!.map((item, index) => (
            <li
              key={`${section.title}-${item.title}-${index}`}
              className="min-w-0"
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
      {section.imageLoading ? (
        <div
          className="flex items-center gap-2.5"
          role="status"
          aria-label="Generating image"
        >
          <div className="skeleton-shimmer aspect-square w-14 shrink-0 rounded-lg" />
          <div className="flex flex-col gap-1.5">
            <div className="skeleton-shimmer h-2.5 w-24 rounded-full" />
            <div className="skeleton-shimmer h-2.5 w-16 rounded-full" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function extractToolImageParts(
  output: unknown,
): Array<{ data: string; mediaType: string }> {
  if (!Array.isArray(output)) return [];
  return output
    .filter(
      (part): part is { type: "image"; data: string; mediaType?: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "image" &&
        typeof (part as { data?: unknown }).data === "string",
    )
    .map((part) => ({
      data: part.data,
      mediaType: part.mediaType ?? "image/png",
    }));
}

function ToolResultImages({ output }: { output: unknown }) {
  const { open } = useImagePreview();
  const images = extractToolImageParts(output);
  if (images.length === 0) return null;

  return (
    <div className="grid grid-cols-3 gap-2" role="list" aria-label="Result images">
      {images.map((image, index) => (
        <button
          key={`${image.mediaType}-${index}`}
          type="button"
          role="listitem"
          aria-label={`View result image ${index + 1}`}
          onClick={() =>
            open({
              src: `data:${image.mediaType};base64,${image.data}`,
              alt: `Result image ${index + 1}`,
            })
          }
          className="cursor-zoom-in overflow-hidden rounded-lg border border-white/[0.06] transition hover:border-white/[0.14] active:scale-[0.98]"
        >
          <img
            src={`data:${image.mediaType};base64,${image.data}`}
            alt=""
            loading="lazy"
            className="aspect-video w-full object-cover"
          />
        </button>
      ))}
    </div>
  );
}

/** Flat collapsible tool step — no card chrome. */
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
    if (isRunning && isImageToolName(part.toolName)) {
      // Image generation takes seconds to minutes — show a skeleton tile
      // instead of a bare "Working…" so the user can see the pending image.
      return {
        title: "Result",
        imageLoading: true,
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

  const labelTone = isError
    ? "text-danger"
    : isRunning
      ? "text-text"
      : "text-text-muted group-hover/activity:text-text";

  const statusTone = isError
    ? "text-danger/80"
    : isRunning
      ? "text-accent"
      : "text-text-faint";

  return (
    <div className="text-xs text-text-muted">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          userToggledRef.current = true;
          setOpen((current) => !current);
        }}
        className="group/activity inline-flex max-w-full cursor-pointer items-center gap-1.5 py-0.5 text-left transition-colors duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.99]"
      >
        <ChevronDown
          className={`size-3.5 shrink-0 text-text-faint transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/activity:text-text-muted ${
            open ? "rotate-0" : "-rotate-90"
          }`}
          strokeWidth={2}
        />
        {isRunning ? (
          <Loader2
            className="size-3.5 shrink-0 animate-spin text-accent"
            strokeWidth={2}
          />
        ) : null}
        <span className={`min-w-0 truncate font-medium tracking-tight ${labelTone}`}>
          {label}
        </span>
        <span className={`shrink-0 text-[11px] font-medium ${statusTone}`}>
          · {statusLabel(part)}
        </span>
      </button>

      {open ? (
        <div
          id={panelId}
          className={`mt-1.5 ml-1.5 space-y-3 border-l pl-3 animate-fade-in ${
            isError ? "border-danger/30" : "border-white/[0.08]"
          }`}
        >
          <ToolSectionView section={requestSection} />
          <ToolSectionView section={resultSection} />
          {isDone && !isMessageImageToolName(part.toolName) ? (
            <ToolResultImages output={parseToolValue(part.output)} />
          ) : null}
        </div>
      ) : (
        <div id={panelId} hidden />
      )}
    </div>
  );
}

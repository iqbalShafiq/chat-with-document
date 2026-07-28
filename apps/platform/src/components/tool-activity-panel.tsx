import type { UIMessagePart } from "@anvia/react";

const TOOL_LABELS: Record<string, string> = {
  find_documents: "Finding documents",
  search_document_pages: "Searching document pages",
  get_document_next_page: "Reading next page",
  descriptive_stats: "Computing statistics",
  pearson_correlation: "Computing correlation",
  linear_regression: "Fitting regression",
};

export function getToolActivityLabel(part: Extract<UIMessagePart, { type: "tool" }>) {
  return TOOL_LABELS[part.toolName] ?? `Running ${part.toolName}`;
}

export function ToolActivityPanel({
  part,
}: {
  part: Extract<UIMessagePart, { type: "tool" }>;
}) {
  const label = getToolActivityLabel(part);
  const isRunning =
    part.state === "input-streaming" || part.state === "input-available";
  const isError = part.state === "error";

  return (
    <div
      className={`rounded-xl border px-3 py-2 text-xs ${
        isError
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : isRunning
            ? "border-amber-200 bg-amber-50 text-amber-800"
            : "border-emerald-200 bg-emerald-50 text-emerald-800"
      }`}
    >
      <p className="font-medium">{label}</p>
      {isRunning ? <p className="mt-1 text-[11px] opacity-80">Working...</p> : null}
      {part.state === "output-available" ? (
        <p className="mt-1 text-[11px] opacity-80">Completed</p>
      ) : null}
    </div>
  );
}

export type FormattedField = {
  label: string;
  value: string;
};

export type FormattedItem = {
  title: string;
  detail?: string;
  meta?: string;
};

export type FormattedSection = {
  title: string;
  summary?: string;
  fields?: FormattedField[];
  items?: FormattedItem[];
  emptyText?: string;
  /** Image tool in flight — render a skeleton tile instead of empty text. */
  imageLoading?: boolean;
  /** Raw chart spec payload (validated by the panel via parseChartSpec). */
  chart?: unknown;
  /** Raw table payload (validated by the panel via parseTableDto). */
  table?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

export function truncate(text: string, max = 280): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function formatPage(pageIndex: number): string {
  return `Page ${pageIndex + 1}`;
}

function formatNumber(value: number, digits = 4): string {
  if (Number.isInteger(value)) return String(value);
  const fixed = value.toFixed(digits);
  return fixed.replace(/\.?0+$/, "");
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function genericFields(value: unknown, maxFields = 8): FormattedField[] {
  if (!isRecord(value)) {
    const text = asString(value);
    return text ? [{ label: "Value", value: truncate(text, 400) }] : [];
  }

  const fields: FormattedField[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (fields.length >= maxFields) break;
    if (entry === undefined || entry === null) continue;

    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      fields.push({
        label: humanizeKey(key),
        value:
          typeof entry === "string"
            ? truncate(entry, 320)
            : typeof entry === "number"
              ? formatNumber(entry)
              : String(entry),
      });
      continue;
    }

    if (Array.isArray(entry)) {
      fields.push({
        label: humanizeKey(key),
        value: countLabel(entry.length, "item"),
      });
      continue;
    }

    if (isRecord(entry)) {
      fields.push({
        label: humanizeKey(key),
        value: `${Object.keys(entry).length} fields`,
      });
    }
  }

  return fields;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

function formatSearchDocumentPagesInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const fields: FormattedField[] = [];

  const query = asString(record.query);
  if (query) fields.push({ label: "Query", value: truncate(query, 400) });

  const documentIds = asArray(record.documentIds).filter(
    (id): id is string => typeof id === "string",
  );
  if (documentIds.length > 0) {
    fields.push({
      label: "Documents",
      value: countLabel(documentIds.length, "document"),
    });
  }

  const limit = asNumber(record.limit);
  if (limit !== null) fields.push({ label: "Limit", value: String(limit) });

  return {
    title: "Request",
    fields,
    emptyText: fields.length === 0 ? "Waiting for request…" : undefined,
  };
}

function formatSearchDocumentPagesOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const results = asArray(record.results);
  const items: FormattedItem[] = [];

  for (const result of results.slice(0, 6)) {
    if (!isRecord(result)) continue;
    const filename = asString(result.filename) ?? "Document";
    const pageIndex = asNumber(result.pageIndex);
    const score = asNumber(result.score);
    const chunks = asArray(result.matchedChunks);
    const topChunk = chunks.find(isRecord);
    const snippet = topChunk ? asString(topChunk.chunkText) : null;

    const metaParts: string[] = [];
    if (pageIndex !== null) metaParts.push(formatPage(pageIndex));
    if (score !== null) metaParts.push(formatScore(score));
    if (chunks.length > 1) {
      metaParts.push(countLabel(chunks.length, "chunk"));
    }

    items.push({
      title: filename,
      meta: metaParts.join(" · ") || undefined,
      detail: snippet ? truncate(snippet, 220) : undefined,
    });
  }

  const remaining = results.length - items.length;
  if (remaining > 0) {
    items.push({
      title: `+${remaining} more match${remaining === 1 ? "" : "es"}`,
    });
  }

  return {
    title: "Result",
    summary:
      results.length === 0
        ? "No matching pages"
        : countLabel(results.length, "page match", "page matches"),
    items: items.length > 0 ? items : undefined,
    emptyText: results.length === 0 ? "No pages matched this query." : undefined,
  };
}

function formatGetDocumentNextPageInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const fields: FormattedField[] = [];

  const documentId = asString(record.documentId);
  if (documentId) {
    fields.push({ label: "Document", value: shortId(documentId) });
  }

  const pageIndex = asNumber(record.pageIndex);
  if (pageIndex !== null) {
    fields.push({ label: "From page", value: formatPage(pageIndex) });
  }

  return {
    title: "Request",
    fields,
    emptyText: fields.length === 0 ? "Waiting for request…" : undefined,
  };
}

function formatGetDocumentNextPageOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const found = record.found === true;
  const fields: FormattedField[] = [];

  if (!found) {
    const reason = asString(record.reason) ?? "Next page not available";
    return {
      title: "Result",
      summary: "Not found",
      fields: [{ label: "Reason", value: reason }],
    };
  }

  const filename = asString(record.filename);
  if (filename) fields.push({ label: "Document", value: filename });

  const pageIndex = asNumber(record.pageIndex);
  if (pageIndex !== null) fields.push({ label: "Page", value: formatPage(pageIndex) });

  const summary = asString(record.summary);
  if (summary) fields.push({ label: "Summary", value: truncate(summary, 320) });

  const rawMarkdown = asString(record.rawMarkdown);
  if (rawMarkdown) {
    fields.push({ label: "Preview", value: truncate(rawMarkdown, 320) });
  }

  if (typeof record.hasNextPage === "boolean") {
    fields.push({
      label: "Has next page",
      value: record.hasNextPage ? "Yes" : "No",
    });
  }

  return {
    title: "Result",
    summary: pageIndex !== null ? `Loaded ${formatPage(pageIndex)}` : "Page loaded",
    fields,
  };
}

function formatFindDocumentsInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const fields: FormattedField[] = [];

  const query = asString(record.query);
  if (query) fields.push({ label: "Query", value: truncate(query, 400) });

  const limit = asNumber(record.limit);
  if (limit !== null) fields.push({ label: "Limit", value: String(limit) });

  return {
    title: "Request",
    fields,
    emptyText: fields.length === 0 ? "Waiting for request…" : undefined,
  };
}

function formatFindDocumentsOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const results = asArray(record.results);
  const items: FormattedItem[] = [];

  for (const result of results.slice(0, 8)) {
    if (!isRecord(result)) continue;
    const filename = asString(result.filename) ?? "Document";
    const pageCount = asNumber(result.pageCount);
    const summary =
      asString(result.firstPageSummary) ?? asString(result.summary);

    items.push({
      title: filename,
      meta: pageCount !== null ? countLabel(pageCount, "page") : undefined,
      detail: summary ? truncate(summary, 200) : undefined,
    });
  }

  return {
    title: "Result",
    summary:
      results.length === 0
        ? "No documents found"
        : countLabel(results.length, "document"),
    items: items.length > 0 ? items : undefined,
    emptyText: results.length === 0 ? "No documents matched this query." : undefined,
  };
}

function formatDescriptiveStatsInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const values = asArray(record.values).filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  const fields: FormattedField[] = [
    { label: "Values", value: countLabel(values.length, "number") },
  ];

  if (values.length > 0) {
    fields.push({
      label: "Range",
      value: `${formatNumber(Math.min(...values))} – ${formatNumber(Math.max(...values))}`,
    });
  }

  return { title: "Request", fields };
}

function formatDescriptiveStatsOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const fields: FormattedField[] = [];
  const keys: Array<[string, string]> = [
    ["count", "Count"],
    ["mean", "Mean"],
    ["median", "Median"],
    ["min", "Min"],
    ["max", "Max"],
    ["range", "Range"],
    ["stdDev", "Std. deviation"],
    ["variance", "Variance"],
    ["q1", "Q1"],
    ["q3", "Q3"],
    ["iqr", "IQR"],
    ["skewness", "Skewness"],
  ];

  for (const [key, label] of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      fields.push({ label, value: formatNumber(value) });
    } else if (value === null && key === "skewness") {
      fields.push({ label, value: "n/a" });
    }
  }

  const mode = record.mode;
  if (Array.isArray(mode) && mode.length > 0) {
    fields.push({
      label: "Mode",
      value: mode
        .filter((v): v is number => typeof v === "number")
        .map((v) => formatNumber(v))
        .join(", "),
    });
  } else if (mode === null) {
    fields.push({ label: "Mode", value: "none" });
  }

  return {
    title: "Result",
    summary: "Descriptive statistics",
    fields,
  };
}

function formatPearsonInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const x = asArray(record.x);
  const y = asArray(record.y);
  return {
    title: "Request",
    fields: [
      { label: "Series X", value: countLabel(x.length, "value") },
      { label: "Series Y", value: countLabel(y.length, "value") },
    ],
  };
}

function formatPearsonOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const fields: FormattedField[] = [];

  const correlation = asNumber(record.correlation);
  if (correlation !== null) {
    fields.push({ label: "Correlation (r)", value: formatNumber(correlation) });
  }

  const direction = asString(record.direction);
  if (direction) fields.push({ label: "Direction", value: humanizeKey(direction) });

  const strength = asString(record.strength);
  if (strength) fields.push({ label: "Strength", value: humanizeKey(strength) });

  const rSquared = asNumber(record.rSquared);
  if (rSquared !== null) fields.push({ label: "R²", value: formatNumber(rSquared) });

  const n = asNumber(record.n);
  if (n !== null) fields.push({ label: "Pairs", value: String(n) });

  return {
    title: "Result",
    summary: "Pearson correlation",
    fields,
  };
}

function formatLinearRegressionInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const x = asArray(record.x);
  const predictFor = asArray(record.predictFor);
  const fields: FormattedField[] = [
    { label: "Observations", value: countLabel(x.length, "point") },
  ];
  if (predictFor.length > 0) {
    fields.push({
      label: "Predictions",
      value: countLabel(predictFor.length, "value"),
    });
  }
  return { title: "Request", fields };
}

function formatLinearRegressionOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const fields: FormattedField[] = [];

  const equation = asString(record.equation);
  if (equation) fields.push({ label: "Equation", value: equation });

  const slope = asNumber(record.slope);
  if (slope !== null) fields.push({ label: "Slope", value: formatNumber(slope) });

  const intercept = asNumber(record.intercept);
  if (intercept !== null) {
    fields.push({ label: "Intercept", value: formatNumber(intercept) });
  }

  const rSquared = asNumber(record.rSquared);
  if (rSquared !== null) fields.push({ label: "R²", value: formatNumber(rSquared) });

  const residualStdDev = asNumber(record.residualStdDev);
  if (residualStdDev !== null) {
    fields.push({
      label: "Residual std. dev.",
      value: formatNumber(residualStdDev),
    });
  }

  const predictions = asArray(record.predictions);
  if (predictions.length > 0) {
    fields.push({
      label: "Predictions",
      value: countLabel(predictions.length, "value"),
    });
  }

  return {
    title: "Result",
    summary: "Linear regression",
    fields,
  };
}

function formatGenericInput(input: unknown): FormattedSection {
  if (input === undefined) {
    return {
      title: "Request",
      emptyText: "Waiting for request…",
    };
  }

  return {
    title: "Request",
    fields: genericFields(input),
    emptyText: "No request details",
  };
}

function formatGenericOutput(output: unknown): FormattedSection {
  if (output === undefined) {
    return {
      title: "Result",
      emptyText: "No result yet",
    };
  }

  if (Array.isArray(output)) {
    return {
      title: "Result",
      summary: countLabel(output.length, "item"),
      fields: genericFields({ items: output.length }),
    };
  }

  return {
    title: "Result",
    fields: genericFields(output),
    emptyText: "No result details",
  };
}

function formatGetDocumentPageImagesInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const fields: FormattedField[] = [];

  const documentId = asString(record.documentId);
  if (documentId) fields.push({ label: "Document", value: shortId(documentId) });

  const pageIndex = asNumber(record.pageIndex);
  if (pageIndex !== null) {
    fields.push({ label: "Page", value: formatPage(pageIndex) });
  }

  const limit = asNumber(record.limit);
  if (limit !== null) fields.push({ label: "Limit", value: String(limit) });

  return {
    title: "Request",
    fields,
    emptyText: fields.length === 0 ? "Waiting for request…" : undefined,
  };
}

function formatGetDocumentPageImagesOutput(output: unknown): FormattedSection {
  if (!Array.isArray(output)) return formatGenericOutput(output);

  const textPart = output.find(
    (part): part is { type: "text"; text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string",
  );

  if (textPart) {
    try {
      const parsed = JSON.parse(textPart.text) as unknown;
      if (isRecord(parsed)) {
        if (parsed.found === false) {
          const reason = asString(parsed.reason) ?? "Not available";
          return {
            title: "Result",
            summary: "Not found",
            fields: [{ label: "Reason", value: reason }],
          };
        }

        const imageList = asArray(parsed.images);
        const pageIndex = asNumber(parsed.pageIndex);
        const items: FormattedItem[] = imageList.slice(0, 8).map((entry) => {
          const record = isRecord(entry) ? entry : {};
          const id = asString(record.id) ?? "image";
          const mediaType = asString(record.mediaType) ?? "image";
          return {
            title: id,
            meta: mediaType,
            detail: asString(record.annotation) ?? undefined,
          };
        });

        return {
          title: "Result",
          summary:
            imageList.length === 0
              ? "No images on this page"
              : `${countLabel(imageList.length, "image")}${pageIndex !== null ? ` · ${formatPage(pageIndex)}` : ""}`,
          items: items.length > 0 ? items : undefined,
          emptyText:
            imageList.length === 0 ? "No images extracted for this page." : undefined,
        };
      }
    } catch {
      // Fall through to generic rendering.
    }
  }

  const imageCount = output.filter(
    (part) => isRecord(part) && part.type === "image",
  ).length;
  return {
    title: "Result",
    summary: `${countLabel(imageCount, "image")} returned`,
  };
}

function formatWebSearchInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const fields: FormattedField[] = [];

  const query = asString(record.query);
  if (query) fields.push({ label: "Query", value: truncate(query, 400) });

  const reason = asString(record.reason);
  if (reason) fields.push({ label: "Reason", value: truncate(reason, 320) });

  const maxResults = asNumber(record.maxResults);
  if (maxResults !== null) fields.push({ label: "Max results", value: String(maxResults) });

  const timeRange = asString(record.timeRange);
  if (timeRange) fields.push({ label: "Time range", value: humanizeKey(timeRange) });

  return {
    title: "Request",
    fields,
    emptyText: fields.length === 0 ? "Waiting for request…" : undefined,
  };
}

function formatWebSearchOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const results = asArray(record.results);
  const items: FormattedItem[] = [];

  for (const result of results.slice(0, 5)) {
    if (!isRecord(result)) continue;
    const title = asString(result.title) ?? asString(result.url) ?? "Result";
    const url = asString(result.url);
    const score = asNumber(result.score);
    const content = asString(result.content);

    items.push({
      title,
      detail: content ? truncate(content, 220) : undefined,
      ...(url || score !== null
        ? {
            meta: [
              url ? safeHostname(url) : null,
              score !== null ? formatScore(score) : null,
            ]
              .filter(Boolean)
              .join(" · ") || undefined,
          }
        : {}),
    });
  }

  return {
    title: "Result",
    summary:
      results.length === 0
        ? (asString(record.error) ?? "No results")
        : countLabel(results.length, "result"),
    items: items.length > 0 ? items : undefined,
    emptyText: results.length === 0 ? "No web results returned." : undefined,
  };
}

function formatWebFetchInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const fields: FormattedField[] = [];

  const url = asString(record.url);
  if (url) fields.push({ label: "URL", value: truncate(url, 320) });

  const reason = asString(record.reason);
  if (reason) fields.push({ label: "Reason", value: truncate(reason, 320) });

  return {
    title: "Request",
    fields,
    emptyText: fields.length === 0 ? "Waiting for request…" : undefined,
  };
}

function formatWebFetchOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const fields: FormattedField[] = [];

  const title = asString(record.title);
  if (title) fields.push({ label: "Title", value: truncate(title, 200) });

  const url = asString(record.url);
  if (url) fields.push({ label: "URL", value: truncate(url, 200) });

  const content = asString(record.content);
  if (content) fields.push({ label: "Content", value: truncate(content, 400) });

  return {
    title: "Result",
    summary: title ? "Page fetched" : "Not fetched",
    fields,
    emptyText: fields.length === 0 ? "No page content." : undefined,
  };
}

/** Shared fields for generate_image / edit_image requests (never the bytes). */
function formatImageGenInputFields(
  record: Record<string, unknown>,
): FormattedField[] {
  const fields: FormattedField[] = [];

  const prompt = asString(record.prompt);
  if (prompt) fields.push({ label: "Prompt", value: truncate(prompt, 400) });

  const referenceImageId = asString(record.referenceImageId);
  if (referenceImageId) {
    fields.push({ label: "Reference", value: shortId(referenceImageId) });
  }

  const modelId = asString(record.modelId);
  if (modelId) fields.push({ label: "Model", value: modelId });

  const aspectRatio = asString(record.aspectRatio);
  if (aspectRatio) fields.push({ label: "Aspect ratio", value: aspectRatio });

  const quality = asString(record.quality);
  if (quality) fields.push({ label: "Quality", value: quality });

  const background = asString(record.background);
  if (background) fields.push({ label: "Background", value: background });

  const n = asNumber(record.n);
  if (n !== null) fields.push({ label: "Count", value: String(n) });

  return fields;
}

/** Shared result shape for both image tools: { images: [...meta] } — no bytes. */
function formatImageGenOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const images = asArray(record.images);
  const fields: FormattedField[] = [];

  const error = asString(record.error);
  if (error) fields.push({ label: "Error", value: truncate(error, 320) });

  const first = images.find(isRecord);
  const modelId = first ? asString(first.modelId) : null;
  if (modelId) fields.push({ label: "Model", value: modelId });

  if (images.length > 0) {
    return {
      title: "Result",
      summary: countLabel(images.length, "image"),
      fields,
    };
  }

  return {
    title: "Result",
    summary: error ? "No images generated" : "No result yet",
    fields,
    emptyText: error ? undefined : "No images produced.",
  };
}

function formatGenerateImageInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const fields = formatImageGenInputFields(record);
  return {
    title: "Request",
    fields,
    emptyText: fields.length === 0 ? "Waiting for request…" : undefined,
  };
}

function formatGenerateImageOutput(output: unknown): FormattedSection {
  return formatImageGenOutput(output);
}

function formatEditImageInput(input: unknown): FormattedSection {
  const record = isRecord(input) ? input : {};
  const fields = formatImageGenInputFields(record);
  return {
    title: "Request",
    fields,
    emptyText: fields.length === 0 ? "Waiting for request…" : undefined,
  };
}

function formatEditImageOutput(output: unknown): FormattedSection {
  return formatImageGenOutput(output);
}

function formatReadDatasetOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const columns = asArray(record.columns).filter(
    (c) => isRecord(c) && typeof c.name === "string",
  );
  const preview = asArray(record.preview);
  return {
    title: "Result",
    summary: `Dataset: ${asString(record.name) ?? "—"} · ${String(record.rowCount ?? 0)} rows`,
    fields: columns.slice(0, 8).map((c) => ({
      label: (c as { name: string }).name,
      value: String((c as { type?: unknown }).type ?? ""),
    })),
    table: isRecord(record)
      ? { columns, rows: preview, rowCount: record.rowCount, truncated: false }
      : undefined,
  };
}

function formatAnalyzeDatasetOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  return {
    title: "Result",
    summary: asString(record.summary) ?? "Analysis",
    ...(isRecord(record.result) ? { table: record.result } : {}),
    ...(isRecord(record.chart) ? { chart: record.chart } : {}),
  };
}

function formatQueryDatasetSqlOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const rawColumns = asArray(record.columns);
  const columns = rawColumns
    .map((c) => {
      if (isRecord(c) && typeof c.name === "string") return c as { name: string; type: string };
      if (typeof c === "string") return { name: c, type: "string" as const };
      return null;
    })
    .filter((c): c is { name: string; type: string } => c !== null);
  const rows = asArray(record.rows);
  const rowCount = asNumber(record.rowCount) ?? rows.length;
  const truncated = typeof record.truncated === "boolean" ? record.truncated : false;
  return {
    title: "Result",
    summary: `${String(rowCount)} row${rowCount === 1 ? "" : "s"}`,
    table: { columns, rows, rowCount, truncated },
  };
}

function formatExtractDocumentTablesOutput(output: unknown): FormattedSection {
  const record = isRecord(output) ? output : {};
  const tables = asArray(record.tables);
  return {
    title: "Result",
    summary: `${tables.length} table${tables.length === 1 ? "" : "s"} found`,
    items: tables.slice(0, 10).map((t) => {
      const rec = isRecord(t) ? t : {};
      const filename = asString(rec.filename) ?? "";
      const cols = asArray(rec.columns).filter(
        (c) => isRecord(c) && typeof c.name === "string",
      );
      return {
        title: `${filename} · page ${Number(rec.pageIndex) + 1} · table ${Number(rec.tableIndex) + 1}`,
        meta: `${cols.length} columns · ${String(rec.rowCount ?? 0)} rows`,
      };
    }),
  };
}

export function formatToolInput(
  toolName: string,
  input: unknown,
): FormattedSection {
  switch (toolName) {
    case "search_document_pages":
      return formatSearchDocumentPagesInput(input);
    case "get_document_next_page":
      return formatGetDocumentNextPageInput(input);
    case "find_documents":
      return formatFindDocumentsInput(input);
    case "descriptive_stats":
      return formatDescriptiveStatsInput(input);
    case "pearson_correlation":
      return formatPearsonInput(input);
    case "linear_regression":
      return formatLinearRegressionInput(input);
    case "get_document_page_images":
      return formatGetDocumentPageImagesInput(input);
    case "web_search":
      return formatWebSearchInput(input);
    case "web_fetch":
      return formatWebFetchInput(input);
    case "generate_image":
      return formatGenerateImageInput(input);
    case "edit_image":
      return formatEditImageInput(input);
    default:
      return formatGenericInput(input);
  }
}

export function formatToolOutput(
  toolName: string,
  output: unknown,
): FormattedSection {
  switch (toolName) {
    case "search_document_pages":
      return formatSearchDocumentPagesOutput(output);
    case "get_document_next_page":
      return formatGetDocumentNextPageOutput(output);
    case "find_documents":
      return formatFindDocumentsOutput(output);
    case "descriptive_stats":
      return formatDescriptiveStatsOutput(output);
    case "pearson_correlation":
      return formatPearsonOutput(output);
    case "linear_regression":
      return formatLinearRegressionOutput(output);
    case "get_document_page_images":
      return formatGetDocumentPageImagesOutput(output);
    case "web_search":
      return formatWebSearchOutput(output);
    case "web_fetch":
      return formatWebFetchOutput(output);
    case "generate_image":
      return formatGenerateImageOutput(output);
    case "edit_image":
      return formatEditImageOutput(output);
    case "read_dataset":
      return formatReadDatasetOutput(output);
    case "analyze_dataset":
      return formatAnalyzeDatasetOutput(output);
    case "query_dataset_sql":
      return formatQueryDatasetSqlOutput(output);
    case "extract_document_tables":
      return formatExtractDocumentTablesOutput(output);
    default:
      return formatGenericOutput(output);
  }
}

/** Parse tool input that may arrive as a JSON string during streaming. */
export function parseToolValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

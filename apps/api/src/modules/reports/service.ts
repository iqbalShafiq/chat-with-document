import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
type PdfDoc = {
  font(name: string): PdfDoc;
  fontSize(n: number): PdfDoc;
  text(t: string, opts?: Record<string, unknown>): PdfDoc;
  image(src: Buffer | string, opts?: Record<string, unknown>): PdfDoc;
  moveDown(n?: number): PdfDoc;
  end(): void;
  on(ev: string, fn: (arg?: unknown) => void): void;
  y: number;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require("pdfkit") as new (opts?: Record<string, unknown>) => PdfDoc;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SVGtoPDF = require("svg-to-pdfkit") as (
  doc: unknown,
  svg: string,
  x: number,
  y: number,
  opts?: Record<string, unknown>,
) => void;

export type ReportCitation = {
  claim: string;
  documentId?: string;
  pageIndex?: number;
  webBundleId?: string;
  url?: string;
};

export type ReportRasterAsset = { buffer: Uint8Array; mediaType: string };

export async function buildReportPdf(input: {
  title: string;
  markdown: string;
  svgAssets?: string[];
  rasterAssets?: ReportRasterAsset[];
  citationMap?: ReportCitation[];
}): Promise<Uint8Array> {
  const doc = new PDFDocument({ margin: 48, size: "A4" });
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve, reject) => {
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve());
    doc.on("error", (e) => reject(e as Error));
  });
  doc.font("Helvetica").fontSize(20).text(input.title);
  doc.moveDown(1);
  for (const rawLine of input.markdown.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    const h = line.match(/^#{1,3}\s+(.*)/);
    if (h) {
      doc.font("Helvetica-Bold").fontSize(14);
      renderInline(doc, h[1]!, 14);
    } else if (/^[-*]\s+/.test(line)) {
      doc.font("Helvetica").fontSize(10);
      renderInline(doc, `•  ${line.replace(/^[-*]\s+/, "")}`, 10);
    } else {
      doc.font("Helvetica").fontSize(10);
      renderInline(doc, line, 10);
    }
    doc.moveDown(0.4);
  }
  for (const svg of input.svgAssets ?? []) {
    doc.moveDown(0.5);
    SVGtoPDF(doc, svg, 48, doc.y, { width: 500 });
    doc.moveDown(1);
  }
  for (const asset of input.rasterAssets ?? []) {
    try {
      doc.moveDown(0.5);
      doc.image(Buffer.from(asset.buffer), { fit: [500, 360] });
      doc.moveDown(1);
    } catch {
      // A corrupt asset must not sink the whole report.
    }
  }
  if (input.citationMap?.length) {
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(12).text("Sources");
    for (const cite of input.citationMap) {
      const ref = cite.documentId
        ? `${cite.documentId}${cite.pageIndex !== undefined ? ` p.${cite.pageIndex + 1}` : ""}`
        : (cite.webBundleId ?? cite.url ?? "web");
      doc.font("Helvetica-Oblique").fontSize(9).text(`${cite.claim} — [${ref}]`);
    }
  }
  doc.end();
  await done;
  return new Uint8Array(Buffer.concat(chunks));
}

type InlineRun = { text: string; bold: boolean; link?: string };

/** Split a markdown line into bold/plain/link runs (no external md parser). */
export function parseInlineMarkdown(line: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const pattern = /(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) runs.push({ text: line.slice(last, index), bold: false });
    const token = match[0];
    if (token.startsWith("**")) {
      runs.push({ text: token.slice(2, -2), bold: true });
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) runs.push({ text: link[1]!, bold: false, link: link[2]! });
      else runs.push({ text: token, bold: false });
    }
    last = index + token.length;
  }
  if (last < line.length) runs.push({ text: line.slice(last), bold: false });
  return runs.length > 0 ? runs : [{ text: line, bold: false }];
}

function renderInline(doc: PdfDoc, line: string, size: number): void {
  const runs = parseInlineMarkdown(line);
  runs.forEach((run, index) => {
    const opts: Record<string, unknown> = { continued: index < runs.length - 1 };
    if (run.link) opts.link = run.link;
    doc
      .font(run.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(size)
      .text(run.text, opts);
  });
}

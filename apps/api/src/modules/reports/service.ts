import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
type PdfDoc = {
  font(name: string): PdfDoc;
  fontSize(n: number): PdfDoc;
  text(t: string, opts?: Record<string, unknown>): PdfDoc;
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

export async function buildReportPdf(input: {
  title: string;
  markdown: string;
  svgAssets?: string[];
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
      doc.font("Helvetica-Bold").fontSize(14).text(h[1]!);
    } else if (/^[-*]\s+/.test(line)) {
      doc.font("Helvetica").fontSize(10).text(`•  ${line.replace(/^[-*]\s+/, "")}`);
    } else {
      doc.font("Helvetica").fontSize(10).text(line);
    }
    doc.moveDown(0.4);
  }
  for (const svg of input.svgAssets ?? []) {
    doc.moveDown(0.5);
    SVGtoPDF(doc, svg, 48, doc.y, { width: 500 });
    doc.moveDown(1);
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

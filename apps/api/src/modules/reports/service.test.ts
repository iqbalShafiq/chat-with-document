import { describe, expect, it } from "vitest";
import { buildReportPdf } from "./service.js";
import { chartSpecToSvg } from "../charts/snapshot.js";

describe("buildReportPdf", () => {
  it("embeds title, markdown text, and citations into a PDF", async () => {
    const pdf = await buildReportPdf({
      title: "Laporan",
      markdown: "# Halo\nIsi laporan.",
      citationMap: [{ claim: "angka", documentId: "d1", pageIndex: 0 }],
    });
    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(String.fromCharCode(...pdf.slice(0, 5))).toBe("%PDF-");
  });

  it("embeds a chart snapshot SVG without going blank", async () => {
    const svg = chartSpecToSvg({
      kind: "bar",
      labels: ["A", "B"],
      series: [{ name: "sum(x)", values: [3, 7] }],
      title: "Chart",
    });
    const pdf = await buildReportPdf({
      title: "Laporan",
      markdown: "Hasil analisis.",
      svgAssets: [svg],
    });
    expect(pdf.byteLength).toBeGreaterThan(1000);
    expect(String.fromCharCode(...pdf.slice(0, 5))).toBe("%PDF-");
  });
});

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProvenanceBadge, provenanceTitle } from "./provenance-badge";

describe("ProvenanceBadge", () => {
  it("renders nothing for uploads", () => {
    expect(renderToStaticMarkup(<ProvenanceBadge origin="upload" />)).toBe("");
    expect(renderToStaticMarkup(<ProvenanceBadge origin={null} />)).toBe("");
  });
  it("renders Olahan and Unduhan chips", () => {
    expect(renderToStaticMarkup(<ProvenanceBadge origin="created" />)).toContain("Olahan");
    expect(renderToStaticMarkup(<ProvenanceBadge origin="fetched" />)).toContain("Unduhan");
  });
});

describe("provenanceTitle", () => {
  it("describes derived, downloaded, and upload sources", () => {
    expect(provenanceTitle({ origin: "created", parentFilename: "sales.csv" })).toContain("sales.csv");
    expect(provenanceTitle({ origin: "fetched", originUrl: "https://example.com/a.csv" })).toContain("https://example.com/a.csv");
    expect(provenanceTitle({ origin: "upload" })).toBeNull();
  });
});

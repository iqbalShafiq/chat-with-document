import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PinnedArtifactChips, splitPinnedText } from "./pinned-artifact-chips";

describe("splitPinnedText", () => {
  it("leaves plain text untouched", () => {
    expect(splitPinnedText("halo dunia")).toEqual({ cleanText: "halo dunia", refs: [] });
  });

  it("splits mixed text into clean text plus chip refs", () => {
    const { cleanText, refs } = splitPinnedText(
      "Lanjutkan site ini [@site Kedai Kopi (site-abc123)]",
    );
    expect(cleanText).toBe("Lanjutkan site ini");
    expect(refs).toEqual([{ type: "site", id: "site-abc123", label: "Kedai Kopi" }]);
  });

  it("handles pin-only messages, including label-less tokens", () => {
    const { cleanText, refs } = splitPinnedText(
      "[@site 74aad355-7f58-4b47-9a7e-b491db103769 (74aad355-7f58-4b47-9a7e-b491db103769)]",
    );
    expect(cleanText).toBe("");
    expect(refs).toEqual([
      {
        type: "site",
        id: "74aad355-7f58-4b47-9a7e-b491db103769",
        label: "74aad355-7f58-4b47-9a7e-b491db103769",
      },
    ]);
  });
});

describe("PinnedArtifactChips", () => {
  it("renders chips without leaking raw tokens", () => {
    const html = renderToStaticMarkup(
      <PinnedArtifactChips pins={[{ type: "site", id: "abc", label: "Kedai" }]} />,
    );
    expect(html).toContain("Kedai");
    expect(html).not.toContain("[@site");
    expect(html).not.toContain("Remove pinned");
  });

  it("renders remove buttons only when onRemove is given", () => {
    const html = renderToStaticMarkup(
      <PinnedArtifactChips
        pins={[{ type: "document", id: "d1", label: "Laporan" }]}
        onRemove={() => undefined}
      />,
    );
    expect(html).toContain("Remove pinned document Laporan");
  });
});

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PinnedTextPart } from "./pinned-text-part";

describe("PinnedTextPart", () => {
  it("renders chips and strips tokens for user text", () => {
    const html = renderToStaticMarkup(
      <PinnedTextPart role="user" text="Lihat ini [@site Kedai (abc)]" />,
    );
    expect(html).toContain("Kedai");
    expect(html).not.toContain("[@site");
  });

  it("leaves tokens inside fenced code blocks as plain text", () => {
    const html = renderToStaticMarkup(
      <PinnedTextPart role="assistant" text={'Contoh:\n```\n[@site Kedai (abc)]\n```'} />,
    );
    expect(html).not.toContain("Pinned artifacts");
  });

  it("renders chips-only for pin-only assistant text", () => {
    const html = renderToStaticMarkup(
      <PinnedTextPart role="assistant" text="[@document Laporan (d1)]" />,
    );
    expect(html).toContain("Laporan");
  });

  it("renders plain markdown untouched when there are no pins", () => {
    const html = renderToStaticMarkup(
      <PinnedTextPart role="assistant" text="Halo **dunia**" />,
    );
    expect(html).toContain("dunia");
    expect(html).not.toContain("Pinned artifacts");
  });
});

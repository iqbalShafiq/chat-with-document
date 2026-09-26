import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SitesBrowser } from "./sites-browser";

describe("SitesBrowser", () => {
  it("renders nothing when closed", () => {
    expect(renderToStaticMarkup(<SitesBrowser open={false} onClose={() => {}} sessionId="s1" />)).toBe(
      "",
    );
  });

  it("shows a loading state while fetching the scope list", () => {
    const html = renderToStaticMarkup(<SitesBrowser open onClose={() => {}} sessionId="s1" />);
    expect(html).toContain("Loading sites");
  });

  it("hints to open a chat when sessionless", () => {
    const html = renderToStaticMarkup(<SitesBrowser open onClose={() => {}} sessionId="" />);
    expect(html).toContain("Open a chat first");
  });
});

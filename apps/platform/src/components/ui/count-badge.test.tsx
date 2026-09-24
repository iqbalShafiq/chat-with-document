import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CountBadge } from "./count-badge";

describe("CountBadge", () => {
  it("renders the count with an accessible label", () => {
    const html = renderToStaticMarkup(<CountBadge count={3} label="skills aktif" />);
    expect(html).toContain("3");
    expect(html).toContain('aria-label="3 skills aktif"');
  });
  it("renders nothing when count is zero", () => {
    expect(renderToStaticMarkup(<CountBadge count={0} label="skills aktif" />)).toBe("");
  });
});

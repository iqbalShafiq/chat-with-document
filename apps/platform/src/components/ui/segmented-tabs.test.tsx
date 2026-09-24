import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SegmentedTabs } from "./segmented-tabs";

describe("SegmentedTabs", () => {
  it("marks the selected tab and keeps the others clickable", () => {
    const html = renderToStaticMarkup(
      <SegmentedTabs
        label="Views"
        value="b"
        onSelect={() => {}}
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Views"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-selected="false"');
    expect(html).toContain("cursor-pointer");
  });

  it("renders nothing interactive without options", () => {
    const html = renderToStaticMarkup(
      <SegmentedTabs label="Views" value="a" onSelect={() => {}} options={[]} />,
    );
    expect(html).not.toContain('role="tab"');
  });
});

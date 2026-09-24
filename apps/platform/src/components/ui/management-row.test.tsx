import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ManagementRow } from "./management-row";

describe("ManagementRow", () => {
  it("renders title, switch state, and action labels", () => {
    const html = renderToStaticMarkup(
      <ManagementRow
        title="release-notes"
        subtitle="Draft notes"
        enabled
        onToggle={() => {}}
        toggleLabel="Enable release-notes"
        onEdit={() => {}}
        editLabel="Edit release-notes"
        onDelete={() => {}}
        deleteLabel="Delete release-notes"
      />,
    );
    expect(html).toContain("release-notes");
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Edit release-notes"');
    expect(html).toContain('aria-label="Delete release-notes"');
  });

  it("renders an unchecked switch when disabled", () => {
    const html = renderToStaticMarkup(
      <ManagementRow
        title="x"
        enabled={false}
        onToggle={() => {}}
        toggleLabel="Enable x"
        onEdit={() => {}}
        editLabel="Edit x"
        onDelete={() => {}}
        deleteLabel="Delete x"
      />,
    );
    expect(html).toContain('aria-checked="false"');
  });
});

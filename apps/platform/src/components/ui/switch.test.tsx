import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Switch } from "./switch";

describe("Switch", () => {
  it("renders a checked switch with symmetric knob travel", () => {
    const html = renderToStaticMarkup(
      <Switch checked onToggle={() => {}} label="Skills" />,
    );
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("left-0");
    expect(html).toContain("translate-x-3.5");
  });

  it("renders an unchecked switch at the track start", () => {
    const html = renderToStaticMarkup(
      <Switch checked={false} onToggle={() => {}} label="Skills" />,
    );
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("translate-x-0.5");
  });
});

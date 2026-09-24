import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TasksModal } from "./tasks-modal";

describe("TasksModal", () => {
  it("renders nothing when closed", () => {
    expect(renderToStaticMarkup(<TasksModal open={false} onClose={() => {}} sessionId="s1" />)).toBe(
      "",
    );
  });

  it("shows tasks and schedules tabs with a scope hint when sessionless", () => {
    const html = renderToStaticMarkup(<TasksModal open onClose={() => {}} sessionId="" />);
    expect(html).toContain("Tasks");
    expect(html).toContain("schedules");
    expect(html).toContain("Open a chat first");
  });
});

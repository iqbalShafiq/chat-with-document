// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#/lib/api", () => ({ API_BASE: "http://localhost:4312" }));

vi.mock("#/components/documents/document-preview-modal", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DocumentPreviewModal: ({ open, document }: { open: boolean; document: any }) =>
    open && document ? <div data-testid="doc-preview">{document.filename}</div> : null,
}));

vi.mock("#/lib/api-artifacts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#/lib/api-artifacts")>();
  return {
    ...actual,
    listArtifacts: vi.fn(async (input: { type?: string }) =>
      input.type === "document"
        ? [{ type: "document", id: "doc-1", filename: "Laporan.pdf", kind: "report" }]
        : [
            {
              type: "site",
              id: "site-1",
              siteId: "site-1",
              version: 2,
              status: "ready",
              previewUrl: "/api/sites/site-1/v2/preview/index.html",
              title: "Kedai",
            },
            {
              type: "site",
              id: "site-2",
              siteId: "site-2",
              status: "building",
              previewUrl: null,
              title: "Warkop",
            },
          ],
    ),
    getArtifact: vi.fn(async () => null),
  };
});

// Native <dialog> has no showModal in jsdom — stub it for DialogShell.
HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
  this.removeAttribute("open");
};

import { ArtifactPicker } from "./artifact-picker";

afterEach(cleanup);

describe("ArtifactPicker preview", () => {
  it("opens a site preview without selecting the row", async () => {
    const onSelect = vi.fn();
    render(<ArtifactPicker sessionId="s1" artifactType="site" value={null} onSelect={onSelect} />);
    const preview = await screen.findByRole("button", { name: "Preview site Kedai" });
    await userEvent.click(preview);
    expect(onSelect).not.toHaveBeenCalled();
    const frame = document.querySelector('iframe[title="Preview Kedai"]');
    expect(frame?.getAttribute("src")).toContain("/api/sites/site-1/v2/preview/index.html");
  });

  it("shows a not-ready message when the site has no preview yet", async () => {
    const onSelect = vi.fn();
    render(<ArtifactPicker sessionId="s1" artifactType="site" value={null} onSelect={onSelect} />);
    await userEvent.click(await screen.findByRole("button", { name: "Preview site Warkop" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(await screen.findByText(/still building/i)).toBeTruthy();
  });

  it("opens the document preview modal without selecting the row", async () => {
    const onSelect = vi.fn();
    render(
      <ArtifactPicker sessionId="s1" artifactType="document" value={null} onSelect={onSelect} />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /preview document/i }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(await screen.findByTestId("doc-preview")).toBeTruthy();
  });
});

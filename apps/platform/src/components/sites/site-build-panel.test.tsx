// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { applySiteBuildEvent, SiteBuildPanel } from "./site-build-panel.js";

describe("applySiteBuildEvent", () => {
  it("tracks progress then ready with download", () => {
    const progress = applySiteBuildEvent(null, {
      name: "siteBuildProgress",
      data: { siteId: "s", version: 1, phase: "building", message: "Membangun hero." },
    });
    expect(progress.message).toBe("Membangun hero.");
    expect(progress.phase).toBe("building");
    const ready = applySiteBuildEvent(progress, {
      name: "siteBuildReady",
      data: {
        siteId: "s",
        version: 1,
        previewUrl: "http://127.0.0.1:49111",
        screenshotUrl: null,
        downloadUrl: "/api/sites/s/v1/download",
      },
    });
    expect(ready.downloadUrl).toBe("/api/sites/s/v1/download");
    expect(ready.phase).toBe("ready");
  });

  it("resets preview when a new site starts", () => {
    const first = applySiteBuildEvent(null, {
      name: "siteBuildReady",
      data: {
        siteId: "old",
        version: 1,
        previewUrl: "http://127.0.0.1:49111",
        screenshotUrl: null,
        downloadUrl: "/api/sites/old/v1/download",
      },
    });
    const next = applySiteBuildEvent(first, {
      name: "siteBuildProgress",
      data: { siteId: "new", version: 1, phase: "starting", message: "Menyiapkan." },
    });
    expect(next.previewUrl).toBeNull();
    expect(next.downloadUrl).toBeNull();
  });
});

describe("SiteBuildPanel", () => {
  it("marks done and active steps, shows skeleton before preview", () => {
    render(
      <SiteBuildPanel
        build={{
          siteId: "s",
          version: 2,
          phase: "bundling",
          message: "Build production.",
          previewUrl: null,
          downloadUrl: null,
        }}
        onRetry={() => undefined}
      />,
    );
    expect(screen.getByText("v2 · Build production.")).toBeTruthy();
    expect(screen.getByText("Menyiapkan").getAttribute("data-state")).toBe("done");
    expect(screen.getByText("Build production").getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Siap").getAttribute("data-state")).toBe("todo");
    expect(screen.getByRole("status").textContent).toContain("Pratinjau segera hadir.");
  });

  it("shows preview, download, and retry on failure", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <SiteBuildPanel
        build={{
          siteId: "s",
          version: 1,
          phase: "ready",
          message: "Situs siap diunduh.",
          previewUrl: "http://127.0.0.1:49111",
          downloadUrl: "/api/sites/s/v1/download",
        }}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByTitle("Preview s")).toBeTruthy();
    expect(screen.getByText("Unduh zip").getAttribute("href")).toBe(
      "/api/sites/s/v1/download",
    );

    rerender(
      <SiteBuildPanel
        build={{
          siteId: "s",
          version: 1,
          phase: "failed",
          message: "vite build failed: boom",
          previewUrl: null,
          downloadUrl: null,
        }}
        onRetry={onRetry}
      />,
    );
    screen.getByText("Coba lagi").click();
    expect(onRetry).toHaveBeenCalledWith("s");
  });

  it("renders nothing without a build", () => {
    const { container } = render(<SiteBuildPanel build={null} onRetry={() => undefined} />);
    expect(container.innerHTML).toBe("");
  });
});

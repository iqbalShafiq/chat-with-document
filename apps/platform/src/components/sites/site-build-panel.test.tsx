// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { applySiteBuildEvent, resolveSiteUrl, SiteBuildPanel } from "./site-build-panel.js";
import { API_BASE } from "#/lib/api";

afterEach(() => {
  cleanup();
});

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

describe("resolveSiteUrl", () => {
  it("prefixes relative site paths with the API base", () => {
    expect(resolveSiteUrl("/api/sites/s/v1/download")).toBe(
      `${API_BASE}/api/sites/s/v1/download`,
    );
  });

  it("leaves absolute URLs unchanged", () => {
    expect(resolveSiteUrl("http://127.0.0.1:49111")).toBe(
      "http://127.0.0.1:49111",
    );
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
        versions={[]}
        onRetry={() => undefined}
        onRollback={() => undefined}
      />,
    );
    expect(screen.getByText("v2 · Build production.")).toBeTruthy();
    expect(screen.getByText("Menyiapkan").getAttribute("data-state")).toBe("done");
    expect(screen.getByText("Build production").getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("Siap").getAttribute("data-state")).toBe("todo");
    expect(screen.getByRole("status").textContent).toContain("Pratinjau segera hadir.");
    const activeStep = screen.getByText("Build production");
    expect(activeStep.className).toMatch(/text-accent/);
    const doneStep = screen.getByText("Menyiapkan");
    expect(doneStep.className).toMatch(/text-text-muted/);
    expect(doneStep.querySelector("svg")).toBeTruthy();
    const todoStep = screen.getByText("Siap");
    expect(todoStep.className).toMatch(/text-text-faint/);
    expect(screen.getByRole("status").className).toMatch(/skeleton-shimmer/);
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
        versions={[]}
        onRetry={onRetry}
        onRollback={() => undefined}
      />,
    );
    expect(screen.getByTitle("Preview s").getAttribute("src")).toBe(
      "http://127.0.0.1:49111",
    );
    expect(screen.getByText("Unduh zip").getAttribute("href")).toBe(
      `${API_BASE}/api/sites/s/v1/download`,
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
        versions={[]}
        onRetry={onRetry}
        onRollback={() => undefined}
      />,
    );
    screen.getByText("Coba lagi").click();
    expect(onRetry).toHaveBeenCalledWith("s");
  });

  it("resolves relative preview and download paths against the API base", () => {
    render(
      <SiteBuildPanel
        build={{
          siteId: "s",
          version: 1,
          phase: "ready",
          message: "Situs siap diunduh.",
          previewUrl: "/api/sites/s/v1/preview/index.html",
          downloadUrl: "/api/sites/s/v1/download",
        }}
        versions={[]}
        onRetry={() => undefined}
        onRollback={() => undefined}
      />,
    );
    expect(screen.getByTitle("Preview s").getAttribute("src")).toBe(
      `${API_BASE}/api/sites/s/v1/preview/index.html`,
    );
    expect(screen.getByText("Unduh zip").getAttribute("href")).toBe(
      `${API_BASE}/api/sites/s/v1/download`,
    );
  });

  it("renders version history with stable marker and rollback", () => {
    const onRollback = vi.fn();
    render(
      <SiteBuildPanel
        build={{
          siteId: "s",
          version: 3,
          phase: "ready",
          message: "Situs siap diunduh.",
          previewUrl: "http://127.0.0.1:49111",
          downloadUrl: "/api/sites/s/v3/download",
        }}
        versions={[
          {
            version: 1,
            status: "ready",
            stable: false,
            previewUrl: "/api/sites/s/v1/preview/index.html",
            downloadUrl: "/api/sites/s/v1/download",
          },
          {
            version: 2,
            status: "ready",
            stable: true,
            previewUrl: "/api/sites/s/v2/preview/index.html",
            downloadUrl: "/api/sites/s/v2/download",
          },
          {
            version: 3,
            status: "ready",
            stable: false,
            previewUrl: "http://127.0.0.1:49111",
            downloadUrl: "/api/sites/s/v3/download",
          },
        ]}
        onRetry={() => undefined}
        onRollback={onRollback}
      />,
    );
    expect(screen.getByRole("list", { name: "Versi" })).toBeTruthy();
    expect(screen.getByText(/\(stabil\)/)).toBeTruthy();
    const rollbackButtons = screen.getAllByText("Rollback");
    expect(rollbackButtons).toHaveLength(2);
    rollbackButtons[0].click();
    expect(onRollback).toHaveBeenCalledWith("s", 1);
  });

  it("hides the version list for a single version", () => {
    render(
      <SiteBuildPanel
        build={{
          siteId: "s",
          version: 1,
          phase: "ready",
          message: "Situs siap diunduh.",
          previewUrl: "http://127.0.0.1:49111",
          downloadUrl: "/api/sites/s/v1/download",
        }}
        versions={[
          {
            version: 1,
            status: "ready",
            stable: true,
            previewUrl: "http://127.0.0.1:49111",
            downloadUrl: "/api/sites/s/v1/download",
          },
        ]}
        onRetry={() => undefined}
        onRollback={() => undefined}
      />,
    );
    expect(screen.queryByRole("list", { name: "Versi" })).toBeNull();
  });

  it("renders nothing without a build", () => {
    const { container } = render(
      <SiteBuildPanel
        build={null}
        versions={[]}
        onRetry={() => undefined}
        onRollback={() => undefined}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});

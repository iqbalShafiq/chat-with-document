// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { applySiteBuildEvent, applySiteVersionEvent, resolveSiteUrl, stableSiteUrls, SiteBuildPanel } from "./site-build-panel.js";
import { API_BASE } from "#/lib/api";

beforeEach(() => {
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function () {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function () {
      this.removeAttribute("open");
    };
  }
});

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

describe("applySiteVersionEvent", () => {
  it("appends a running entry when a new version starts", () => {
    const next = applySiteVersionEvent([], {
      name: "siteBuildProgress",
      data: { siteId: "s", version: 2, phase: "building", message: "Membangun." },
    });
    expect(next).toEqual([
      { siteId: "s", version: 2, status: "running", stable: false, previewUrl: null, downloadUrl: null },
    ]);
  });

  it("marks ready with urls and moves the stable flag", () => {
    const prev = applySiteVersionEvent(
      [
        { siteId: "s", version: 1, status: "ready", stable: true, previewUrl: "/api/sites/s/v1/preview/index.html", downloadUrl: "/api/sites/s/v1/download" },
      ],
      {
        name: "siteBuildReady",
        data: {
          siteId: "s",
          version: 2,
          previewUrl: "/api/sites/s/v2/preview/index.html",
          screenshotUrl: null,
          downloadUrl: "/api/sites/s/v2/download",
        },
      },
    );
    expect(prev).toEqual([
      { siteId: "s", version: 1, status: "ready", stable: false, previewUrl: "/api/sites/s/v1/preview/index.html", downloadUrl: "/api/sites/s/v1/download" },
      { siteId: "s", version: 2, status: "ready", stable: true, previewUrl: "/api/sites/s/v2/preview/index.html", downloadUrl: "/api/sites/s/v2/download" },
    ]);
  });

  it("resets the list when events belong to a different site", () => {
    const next = applySiteVersionEvent(
      [
        { siteId: "old", version: 1, status: "ready", stable: true, previewUrl: null, downloadUrl: null },
      ],
      {
        name: "siteBuildProgress",
        data: { siteId: "new", version: 1, phase: "starting", message: "Menyiapkan." },
      },
    );
    expect(next.map((entry) => entry.siteId)).toEqual(["new"]);
  });
  it("marks the entry failed on a failed progress event", () => {
    const next = applySiteVersionEvent([], {
      name: "siteBuildProgress",
      data: { siteId: "s", version: 1, phase: "failed", message: "Build gagal." },
    });
    expect(next).toEqual([
      { siteId: "s", version: 1, status: "failed", stable: false, previewUrl: null, downloadUrl: null },
    ]);
  });
});

describe("stableSiteUrls", () => {
  it("points preview and download at the stable version", () => {
    expect(stableSiteUrls("s", 1)).toEqual({
      previewUrl: "/api/sites/s/v1/preview/index.html",
      downloadUrl: "/api/sites/s/v1/download",
    });
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

  it("shows download and retry on failure without a preview trigger", () => {
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
    expect(screen.getByText("Lihat pratinjau")).toBeTruthy();

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

  it("opens the preview in a full-size dialog only on request", () => {
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
    const dialog = () => document.querySelector("dialog") as HTMLDialogElement | null;
    expect(dialog()?.open).toBe(false);
    act(() => {
      screen.getByText("Lihat pratinjau").click();
    });
    const frame = screen.getByTitle("Preview s");
    expect(frame.getAttribute("src")).toBe(
      `${API_BASE}/api/sites/s/v1/preview/index.html`,
    );
    expect(dialog()?.open).toBe(true);
    act(() => {
      screen.getByRole("button", { name: "Close" }).click();
    });
    expect(dialog()?.open).toBe(false);
  });

  it("renders compact version dropdown with stable marker and rollback", async () => {
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
            siteId: "s",
            version: 1,
            status: "failed",
            stable: false,
            previewUrl: "/api/sites/s/v1/preview/index.html",
            downloadUrl: "/api/sites/s/v1/download",
          },
          {
            siteId: "s",
            version: 2,
            status: "ready",
            stable: true,
            previewUrl: "/api/sites/s/v2/preview/index.html",
            downloadUrl: "/api/sites/s/v2/download",
          },
          {
            siteId: "s",
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
    // Shared Select trigger shows the stable version; options open on click.
    act(() => {
      screen.getByRole("button", { name: /Versi, v2 \(stabil\)/ }).click();
    });
    const listbox = await screen.findByRole("listbox", { name: "Versi" });
    const options = Array.from(listbox.querySelectorAll('[data-option-value]')).map((o) =>
      o.textContent,
    );
    expect(options).toEqual(["v3", "v2 (stabil)", "v1 • gagal"]);
    // Stable version is selected by default, so rollback starts disabled.
    expect((screen.getByRole("button", { name: "Rollback" }) as HTMLButtonElement).disabled).toBe(true);
    const option = listbox.querySelector('[data-option-value="3"]');
    expect(option).not.toBeNull();
    fireEvent.click(option!);
    screen.getByRole("button", { name: "Rollback" }).click();
    expect(onRollback).toHaveBeenCalledWith("s", 3);
  });

  it("hides the version dropdown for a single version", () => {
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
            siteId: "s",
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
    expect(screen.queryByRole("button", { name: /Versi/ })).toBeNull();
  });

  it("marks every step done with no spinner once ready", () => {
    const { container } = render(
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
    expect(screen.getByText("Siap").getAttribute("data-state")).toBe("done");
    expect(screen.queryByRole("button", { name: /langkah|step/i })).toBeNull();
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("collapses and expands the card body", () => {
    const { container } = render(
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
    const isBodyHidden = () => container.querySelector("div[hidden]") !== null;
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
    expect(isBodyHidden()).toBe(false);
    act(() => {
      screen.getByRole("button", { expanded: true }).click();
    });
    expect(screen.getByRole("button", { expanded: false })).toBeTruthy();
    expect(isBodyHidden()).toBe(true);
    act(() => {
      screen.getByRole("button", { expanded: false }).click();
    });
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
    expect(isBodyHidden()).toBe(false);
  });

  it("styles the download link as a button", () => {
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
    const links = screen.getAllByText("Unduh zip").map((node) => node.closest("a"));
    expect(links).toHaveLength(2);
    for (const link of links) {
      expect(link?.getAttribute("href")).toBe(
        `${API_BASE}/api/sites/s/v1/download`,
      );
      expect(link?.className).toMatch(/inline-flex/);
      expect(link?.className).toMatch(/rounded-xl/);
    }
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

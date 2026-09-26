// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock("#/lib/api", () => ({
  API_BASE: "http://localhost:4312",
  apiFetch: mocks.apiFetch,
}));

import { SiteLiveCard } from "./site-live-card";

function jpegResponse() {
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
  };
}

function emptyResponse() {
  return { ok: true, status: 204, blob: async () => new Blob([]) };
}

beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:frame-1");
  URL.revokeObjectURL = vi.fn();
});

afterEach(cleanup);

describe("SiteLiveCard", () => {
  it("polls frames while active and keeps the last frame on 204", async () => {
    mocks.apiFetch.mockResolvedValueOnce(jpegResponse()).mockResolvedValue(emptyResponse());
    render(
      <SiteLiveCard
        view={{ state: "started", siteId: "s1", label: "Kedai" }}
        sessionId="s1"
        onHide={() => undefined}
      />,
    );
    const img = await screen.findByRole("img", { name: /livestream kedai/i });
    expect(img.getAttribute("src")).toBe("blob:frame-1");

    await vi.waitFor(
      () => {
        expect(mocks.apiFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 2_000, interval: 50 },
    );
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/sites/live/s1/frame"),
    );
    expect(screen.getByRole("img", { name: /livestream kedai/i }).getAttribute("src")).toBe(
      "blob:frame-1",
    );
  });

  it("hides when dismissed and reports to the parent", async () => {
    mocks.apiFetch.mockResolvedValue(emptyResponse());
    const onHide = vi.fn();
    render(
      <SiteLiveCard
        view={{ state: "started", siteId: "s1", label: "Kedai" }}
        sessionId="s1"
        onHide={onHide}
      />,
    );
    await userEvent.click(await screen.findByRole("button", { name: /hide live view/i }));
    expect(onHide).toHaveBeenCalled();
  });

  it("renders nothing and never polls once stopped", () => {
    const { container } = render(
      <SiteLiveCard
        view={{ state: "stopped", siteId: "s1", label: "Kedai" }}
        sessionId="s1"
        onHide={() => undefined}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });
});

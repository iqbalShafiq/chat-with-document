// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type SiteEvent =
  | { name: "siteBuildProgress"; data: { siteId: string; version: number; phase: string; message: string } }
  | { name: "siteBuildReady"; data: { siteId: string; version: number; previewUrl: string | null; screenshotUrl: string | null; downloadUrl: string } };

let capturedSiteEvent: ((event: SiteEvent) => void) | null = null;

vi.mock("#/components/chat/chat-session", () => ({
  ChatSession: (props: { composerTopSlot?: React.ReactNode; onSiteBuildEvent?: (event: SiteEvent) => void }) => {
    capturedSiteEvent = props.onSiteBuildEvent ?? null;
    return <div data-testid="chat-session">{props.composerTopSlot}</div>;
  },
  parseMemoryMessages: (data: unknown) => (Array.isArray(data) ? data : []),
}));

vi.mock("#/hooks/use-models", () => ({
  useModels: () => ({ models: [], reasoningEfforts: [], status: "ready", error: null, retry: () => undefined }),
}));

vi.mock("#/components/workspace/workspace-sessions-context", () => ({
  useWorkspaceSessionsContext: () => ({ refreshQuiet: vi.fn(), onImageContextActions: {} }),
}));

vi.mock("#/components/workspace/workspace-not-found", () => ({
  SessionNotFound: () => <div data-testid="not-found" />,
}));

vi.mock("#/components/layout/anreal-brand", () => ({
  AnrealMark: () => <div data-testid="mark" />,
}));

const bySessionPayloads = new Map<string, { sites: unknown[] }>();
const apiCalls: { url: string; init?: RequestInit }[] = [];

vi.mock("#/lib/api", () => ({
  API_BASE: "http://localhost:4312",
  ApiAuthError: class ApiAuthError extends Error {},
  apiFetch: vi.fn(async (url: string, init?: RequestInit) => {
    apiCalls.push({ url, init });
    if (url.includes("/rollback")) {
      return { ok: true, json: async () => ({ stableVersion: 1 }) };
    }
    if (url.includes("/retry")) {
      return { ok: true, json: async () => ({}) };
    }
    if (url.includes("/by-session/")) {
      const sessionId = url.split("/by-session/")[1] ?? "";
      return { ok: true, json: async () => bySessionPayloads.get(sessionId) ?? { sites: [] } };
    }
    throw new Error(`unexpected apiFetch ${url}`);
  }),
  fetchRunStatus: vi.fn(async () => null),
  listSessions: vi.fn(async () => ({ items: [{ sessionId: "session-a" }, { sessionId: "session-b" }] })),
  loadChatMessages: vi.fn(async () => []),
}));

import { ChatRouteView } from "./chat-route-view.js";

const baseProps = {
  projectId: null,
  onAuthFailure: () => undefined,
  onCanonicalSession: () => undefined,
};

function siteEntry(version: number, stableVersion: number) {
  return {
    siteId: "s",
    version,
    stableVersion,
    status: "ready",
    previewUrl: `/api/sites/s/v${version}/preview/index.html`,
    downloadUrl: `/api/sites/s/v${version}/download`,
  };
}

afterEach(() => {
  cleanup();
  bySessionPayloads.clear();
  apiCalls.length = 0;
  capturedSiteEvent = null;
});

describe("ChatRouteView site panel", () => {
  it("shows an in-progress panel for a running build on load", async () => {
    bySessionPayloads.set("session-a", {
      sites: [
        {
          siteId: "s",
          version: 2,
          stableVersion: 1,
          status: "running",
          previewUrl: null,
          downloadUrl: "/api/sites/s/v2/download",
        },
      ],
    });
    render(<ChatRouteView {...baseProps} sessionId="session-a" />);
    await screen.findByLabelText("Site build");
    expect(screen.getByText(/v2 · /)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Pratinjau segera hadir.");
  });

  it("clears the previous session panel when switching sessions", async () => {
    bySessionPayloads.set("session-a", { sites: [siteEntry(1, 1)] });
    bySessionPayloads.set("session-b", { sites: [] });
    const { rerender } = render(<ChatRouteView {...baseProps} sessionId="session-a" />);
    await screen.findByLabelText("Site build");

    rerender(<ChatRouteView {...baseProps} sessionId="session-b" />);
    await screen.findByTestId("chat-session");
    await waitFor(() => {
      expect(screen.queryByLabelText("Site build")).toBeNull();
    });
  });

  it("appends new versions live when a ready event arrives", async () => {
    bySessionPayloads.set("session-a", { sites: [siteEntry(1, 1)] });
    render(<ChatRouteView {...baseProps} sessionId="session-a" />);
    await screen.findByLabelText("Site build");
    expect(screen.queryByRole("button", { name: /Versi/ })).toBeNull();

    act(() => {
      capturedSiteEvent?.({
        name: "siteBuildReady",
        data: {
          siteId: "s",
          version: 2,
          previewUrl: "/api/sites/s/v2/preview/index.html",
          screenshotUrl: null,
          downloadUrl: "/api/sites/s/v2/download",
        },
      });
    });

    const trigger = await screen.findByRole("button", { name: /Versi/ });
    act(() => {
      trigger.click();
    });
    const listbox = await screen.findByRole("listbox", { name: "Versi" });
    const options = Array.from(listbox.querySelectorAll("[data-option-value]")).map((o) => o.textContent);
    expect(options).toEqual(["v2 (stabil)", "v1"]);
  });

  it("follows the stable pointer for download after rollback", async () => {
    bySessionPayloads.set("session-a", { sites: [siteEntry(2, 2)] });
    render(<ChatRouteView {...baseProps} sessionId="session-a" />);
    await screen.findByLabelText("Site build");
    expect(screen.getAllByText("Unduh zip")[0].getAttribute("href")).toContain("/v2/download");

    const select = await screen.findByRole("button", { name: /Versi/ });
    act(() => {
      select.click();
    });
    const listbox = await screen.findByRole("listbox", { name: "Versi" });
    const option = listbox.querySelector('[data-option-value="1"]');
    expect(option).not.toBeNull();
    fireEvent.click(option!);
    screen.getByRole("button", { name: "Rollback" }).click();
    await waitFor(() => {
      expect(screen.getAllByText("Unduh zip")[0].getAttribute("href")).toContain("/v1/download");
    });
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routerState = {
  locationPathname: "/login",
  resolvedPathname: "/login",
};

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <div>auth-form</div>,
  useRouter: () => ({
    routesByPath: {},
    loadRouteChunk: vi.fn(),
  }),
  useRouterState: ({
    select,
  }: {
    select: (state: {
      location: { pathname: string };
      resolvedLocation: { pathname: string };
    }) => unknown;
  }) =>
    select({
      location: { pathname: routerState.locationPathname },
      resolvedLocation: { pathname: routerState.resolvedPathname },
    }),
}));

vi.mock("#/components/auth/auth-chat-demo", () => ({
  AuthChatDemo: () => null,
}));

vi.mock("#/components/auth/preload-workspace", () => ({
  preloadWorkspaceRoute: vi.fn(() => Promise.resolve()),
}));

import { preloadWorkspaceRoute } from "#/components/auth/preload-workspace";
import { AuthShell } from "./auth-shell";

afterEach(() => {
  cleanup();
  routerState.locationPathname = "/login";
  routerState.resolvedPathname = "/login";
});

describe("AuthShell handoff", () => {
  it("presents the anreal identity before authentication", () => {
    render(<AuthShell />);

    expect(screen.getAllByText("anreal").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("img", { name: "anreal monogram" }).length).toBeGreaterThan(0);
  });

  it("keeps the form while still on an auth route", () => {
    render(<AuthShell />);
    expect(screen.getByText("auth-form")).toBeTruthy();
    expect(screen.queryByText("You're in")).toBeNull();
    expect(preloadWorkspaceRoute).toHaveBeenCalled();
  });

  it("shows a success bridge once navigation aims at the workspace", () => {
    routerState.locationPathname = "/";
    routerState.resolvedPathname = "/login";
    render(<AuthShell />);
    expect(screen.queryByText("auth-form")).toBeNull();
    expect(screen.getByText("You're in")).toBeTruthy();
    expect(screen.getByText(/Opening your workspace/)).toBeTruthy();
  });

  it("uses register copy when leaving from register", () => {
    routerState.locationPathname = "/";
    routerState.resolvedPathname = "/register";
    render(<AuthShell />);
    expect(screen.getByText("Account created")).toBeTruthy();
  });
});

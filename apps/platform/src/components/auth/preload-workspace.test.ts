import { describe, expect, it, vi } from "vitest";
import { preloadWorkspaceRoute } from "./preload-workspace";

describe("preloadWorkspaceRoute", () => {
  it("loads the home route chunk when the route exists", async () => {
    const route = { id: "/" };
    const loadRouteChunk = vi.fn(() => Promise.resolve("loaded"));
    await expect(
      preloadWorkspaceRoute({
        routesByPath: { "/": route },
        loadRouteChunk,
      }),
    ).resolves.toBe("loaded");
    expect(loadRouteChunk).toHaveBeenCalledWith(route);
  });

  it("no-ops when the home route is missing", async () => {
    const loadRouteChunk = vi.fn();
    await expect(
      preloadWorkspaceRoute({
        routesByPath: {},
        loadRouteChunk,
      }),
    ).resolves.toBeUndefined();
    expect(loadRouteChunk).not.toHaveBeenCalled();
  });
});

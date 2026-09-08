import { describe, expect, it, vi } from "vitest";

import {
  isSafeRedirect,
  navigateToHref,
  parseRedirectSearch,
} from "./auth-redirect";

describe("auth-redirect", () => {
  it("accepts same-origin app paths only", () => {
    expect(isSafeRedirect("/chat/abc")).toBe(true);
    expect(isSafeRedirect("/projects/p-1/chat/s-1")).toBe(true);
    expect(isSafeRedirect("/")).toBe(true);
    expect(isSafeRedirect("https://evil.test/chat")).toBe(false);
    expect(isSafeRedirect("//evil.test/chat")).toBe(false);
    expect(isSafeRedirect("")).toBe(false);
    expect(isSafeRedirect(undefined)).toBe(false);
  });

  it("parses the redirect search param defensively", () => {
    expect(parseRedirectSearch({ redirect: "/chat/abc" })).toEqual({
      redirect: "/chat/abc",
    });
    expect(parseRedirectSearch({ redirect: "https://evil.test" })).toEqual({
      redirect: undefined,
    });
    expect(parseRedirectSearch({})).toEqual({ redirect: undefined });
  });

  it("navigates through the router for dynamic hrefs", () => {
    const navigate = vi.fn();
    navigateToHref({ navigate }, "/projects/p-1/chat/s-1");
    expect(navigate).toHaveBeenCalledWith({ to: "/projects/p-1/chat/s-1" });
  });
});

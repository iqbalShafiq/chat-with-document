import { describe, expect, it } from "vitest";
import {
  authHandoffCopy,
  authHandoffKind,
  authPaintedPathname,
  isAuthHandoffPending,
  isAuthRoutePath,
} from "./auth-handoff";

describe("isAuthRoutePath", () => {
  it("accepts login and register only", () => {
    expect(isAuthRoutePath("/login")).toBe(true);
    expect(isAuthRoutePath("/register")).toBe(true);
    expect(isAuthRoutePath("/")).toBe(false);
    expect(isAuthRoutePath("/login/extra")).toBe(false);
  });
});

describe("isAuthHandoffPending", () => {
  it("is true only while the app route is requested and auth is still resolved", () => {
    expect(isAuthHandoffPending("/", "/login")).toBe(true);
    expect(isAuthHandoffPending("/", "/register")).toBe(true);
    expect(isAuthHandoffPending("/login", "/login")).toBe(false);
    expect(isAuthHandoffPending("/register", "/login")).toBe(false);
    expect(isAuthHandoffPending("/", "/")).toBe(false);
  });
});

describe("authPaintedPathname", () => {
  it("follows login ↔ register immediately", () => {
    expect(authPaintedPathname("/register", "/login")).toBe("/register");
  });

  it("stays on the last auth page while Home is still loading", () => {
    expect(authPaintedPathname("/", "/login")).toBe("/login");
    expect(authPaintedPathname("/", "/register")).toBe("/register");
  });
});

describe("authHandoffCopy", () => {
  it("uses login vs register success copy", () => {
    expect(authHandoffCopy("login").title).toBe("You're in");
    expect(authHandoffCopy("register").title).toBe("Account created");
    expect(authHandoffKind("/register")).toBe("register");
    expect(authHandoffKind("/login")).toBe("login");
  });
});

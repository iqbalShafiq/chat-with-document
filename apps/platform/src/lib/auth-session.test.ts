import { afterEach, describe, expect, it, vi } from "vitest";

const getSession = vi.fn();

vi.mock("#/lib/auth-client", () => ({
  authClient: {
    getSession: (...args: unknown[]) => getSession(...args),
  },
}));

vi.mock("#/lib/session-storage", () => ({
  clearSessionOnAuth: vi.fn(),
}));

import { clearSessionOnAuth } from "#/lib/session-storage";
import {
  beginWorkspaceHandoff,
  consumeWorkspaceUser,
  getSessionUser,
  rememberWorkspaceUser,
  toSessionUser,
} from "./auth-session";

const user = {
  id: "user-1",
  email: "ada@example.com",
  name: "Ada",
  image: null as string | null,
};

afterEach(() => {
  consumeWorkspaceUser();
  vi.clearAllMocks();
});

describe("toSessionUser", () => {
  it("normalizes a missing image to null", () => {
    expect(
      toSessionUser({ id: "1", email: "a@b.c", name: "Ada" }),
    ).toEqual({
      id: "1",
      email: "a@b.c",
      name: "Ada",
      image: null,
    });
  });
});

describe("workspace handoff user", () => {
  it("returns the remembered user once", () => {
    rememberWorkspaceUser(user);
    expect(consumeWorkspaceUser()).toEqual(user);
    expect(consumeWorkspaceUser()).toBeNull();
  });

  it("stashes the user and clears client session ids", () => {
    beginWorkspaceHandoff(user);
    expect(clearSessionOnAuth).toHaveBeenCalledTimes(1);
    expect(consumeWorkspaceUser()).toEqual(user);
  });
});

describe("getSessionUser", () => {
  it("maps the auth client session when a user is present", async () => {
    getSession.mockResolvedValue({
      data: {
        user: { id: "user-1", email: "ada@example.com", name: "Ada", image: "x" },
      },
    });
    await expect(getSessionUser()).resolves.toEqual({
      id: "user-1",
      email: "ada@example.com",
      name: "Ada",
      image: "x",
    });
    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it("returns null when there is no session user", async () => {
    getSession.mockResolvedValue({ data: null });
    await expect(getSessionUser()).resolves.toBeNull();
  });
});

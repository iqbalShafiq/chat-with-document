import { describe, expect, it } from "vitest";

import {
  chatUrl,
  documentsUrl,
  parseWorkspacePath,
  projectChatUrl,
  projectNavigate,
  projectUrl,
  sessionNavigate,
  sessionUrl,
} from "./workspace-urls";

describe("workspace-urls", () => {
  it("builds canonical standalone and project chat URLs", () => {
    expect(chatUrl("s-1")).toBe("/chat/s-1");
    expect(projectUrl("p-1")).toBe("/projects/p-1");
    expect(projectChatUrl("p-1", "s-1")).toBe("/projects/p-1/chat/s-1");
    expect(documentsUrl()).toBe("/documents");
  });

  it("encodes ids with reserved characters", () => {
    expect(chatUrl("a/b c")).toBe("/chat/a%2Fb%20c");
    expect(projectChatUrl("p/1", "s 2")).toBe("/projects/p%2F1/chat/s%202");
  });

  it("builds typed navigate targets without interpolating ids", () => {
    expect(sessionNavigate({ sessionId: "s-1", projectId: null })).toEqual({
      to: "/chat/$sessionId",
      params: { sessionId: "s-1" },
    });
    expect(sessionNavigate({ sessionId: "s-1", projectId: "p-1" })).toEqual({
      to: "/projects/$projectId/chat/$sessionId",
      params: { projectId: "p-1", sessionId: "s-1" },
    });
    expect(projectNavigate("p-1")).toEqual({
      to: "/projects/$projectId",
      params: { projectId: "p-1" },
    });
  });

  it("resolves a session URL from project membership", () => {
    expect(sessionUrl({ sessionId: "s-1", projectId: null })).toBe(
      "/chat/s-1",
    );
    expect(sessionUrl({ sessionId: "s-1", projectId: "p-1" })).toBe(
      "/projects/p-1/chat/s-1",
    );
  });

  it("parses workspace paths back into targets", () => {
    expect(parseWorkspacePath("/chat/s-1")).toEqual({
      projectId: null,
      sessionId: "s-1",
    });
    expect(parseWorkspacePath("/projects/p-1/chat/s-1")).toEqual({
      projectId: "p-1",
      sessionId: "s-1",
    });
  });

  it("returns null for non-session paths", () => {
    expect(parseWorkspacePath("/")).toBeNull();
    expect(parseWorkspacePath("/login")).toBeNull();
    expect(parseWorkspacePath("/projects")).toBeNull();
    expect(parseWorkspacePath("/documents")).toBeNull();
    expect(parseWorkspacePath("/projects/p-1")).toBeNull();
    expect(parseWorkspacePath("/chat/")).toBeNull();
  });
});

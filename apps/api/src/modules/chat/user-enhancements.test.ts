import { describe, expect, it, vi } from "vitest";
import { resolveUserEnhancements } from "./user-enhancements.js";

function setup() {
  return {
    db: {
      userSkill: {
        findMany: vi.fn(
          async (): Promise<Record<string, unknown>[]> => [
            {
              id: "s1",
              userId: "u1",
              name: "brief",
              description: "d",
              bodyMd: "---\nname: brief\ndescription: d\n---\nb",
              isEnabled: true,
              status: "active",
            },
          ],
        ),
      },
      userMcpServer: {
        findMany: vi.fn(async (): Promise<Record<string, unknown>[]> => [
          {
            id: "m1",
            userId: "u1",
            name: "docs",
            url: "https://mcp.example.com/mcp",
            status: "ok",
            allowedToolsJson: ["search_docs"],
            toolsJson: [
              { name: "search_docs", description: "Search", parameters: { type: "object" } },
              { name: "other", description: "Other", parameters: {} },
            ],
          },
        ]),
      },
    },
  };
}

describe("resolveUserEnhancements", () => {
  it("snapshots owned, enabled skills and drops unknown ids", async () => {
    const { db } = setup();
    const result = await resolveUserEnhancements(db, "u1", {
      skillIds: ["s1", "ghost"],
      mcpServerIds: [],
    });
    expect(result.userSkills.map((s) => s.id)).toEqual(["s1"]);
    expect(result.droppedSkillIds).toEqual(["ghost"]);
  });

  it("freezes only allowed MCP tool definitions", async () => {
    const { db } = setup();
    const result = await resolveUserEnhancements(db, "u1", {
      skillIds: [],
      mcpServerIds: ["m1", "ghost-mcp"],
    });
    expect(result.userMcp).toHaveLength(1);
    expect(result.userMcp[0]?.toolDefinitions.map((t) => t.name)).toEqual([
      "search_docs",
    ]);
    expect(result.droppedMcpServerIds).toEqual(["ghost-mcp"]);
  });

  it("drops untested servers and ones without reviewed tools", async () => {
    const { db } = setup();
    db.userMcpServer.findMany.mockResolvedValueOnce([
      {
        id: "m-untested",
        userId: "u1",
        name: "fresh",
        url: "https://mcp.example.com/mcp",
        status: "untested",
        allowedToolsJson: [],
        toolsJson: [],
      },
      {
        id: "m-err",
        userId: "u1",
        name: "broken",
        url: "https://mcp.example.com/mcp",
        status: "error",
        allowedToolsJson: ["a"],
        toolsJson: [{ name: "a", description: "", parameters: {} }],
      },
    ]);
    const result = await resolveUserEnhancements(db, "u1", {
      skillIds: [],
      mcpServerIds: ["m-untested", "m-err"],
    });
    expect(result.userMcp).toEqual([]);
    expect(result.droppedMcpServerIds).toEqual(["m-untested", "m-err"]);
  });
});

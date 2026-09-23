import { normalizeToolResultOutput } from "@anvia/core/tool";
import { describe, expect, it, vi } from "vitest";
import {
  USER_MCP_TOOL_DEFINITIONS,
  createUserMcpTools,
} from "./user-mcp.js";

function setup() {
  const deps = {
    userId: "u1",
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "m1", name: "docs" })),
    update: vi.fn(async () => ({ id: "m1" })),
    remove: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
    test: vi.fn(async () => ({ ok: true as const, tools: [{ name: "search" }] })),
  };
  return { deps, tools: createUserMcpTools(deps) };
}

type ApprovalFn = (
  args: Record<string, unknown>,
  context: unknown,
) => Promise<false | { reason: string }>;

describe("manage_user_mcp_servers", () => {
  it("registers one tool with a frozen definition", () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual(["manage_user_mcp_servers"]);
    expect(USER_MCP_TOOL_DEFINITIONS.map((def) => def.name)).toEqual([
      "manage_user_mcp_servers",
    ]);
  });

  it("requires approval for mutations but not for list and test", async () => {
    const { tools } = setup();
    const requiresApproval = tools[0]!.requiresApproval as ApprovalFn;
    expect(
      await requiresApproval(
        { action: "create", name: "docs", url: "https://mcp.example.com/mcp", authType: "none" },
        {},
      ),
    ).toEqual({ reason: expect.stringContaining("MCP") });
    expect(await requiresApproval({ action: "list" }, {})).toBe(false);
    expect(
      await requiresApproval(
        { action: "test", url: "https://mcp.example.com/mcp", authType: "none" },
        {},
      ),
    ).toBe(false);
  });

  it("tests through deps without persisting anything", async () => {
    const { deps, tools } = setup();
    const output = await tools[0]!.call({
      action: "test",
      url: "https://mcp.example.com/mcp",
      authType: "none",
    });
    expect(deps.test).toHaveBeenCalledWith({
      url: "https://mcp.example.com/mcp",
      authType: "none",
    });
    expect(normalizeToolResultOutput(output)).toEqual({
      type: "json",
      value: { ok: true, tools: [{ name: "search" }] },
    });
  });

  it("maps service errors to bounded results, never throws", async () => {
    const { deps, tools } = setup();
    deps.create.mockRejectedValueOnce(new Error("MCP server limit reached (5)"));
    const output = await tools[0]!.call({
      action: "create",
      name: "x",
      url: "https://mcp.example.com/mcp",
      authType: "none",
    });
    expect(normalizeToolResultOutput(output)).toEqual({
      type: "json",
      value: { ok: false, error: expect.stringContaining("limit") },
    });
  });

  it("requires approval for every mutation action", async () => {
    const { tools } = setup();
    const requiresApproval = tools[0]!.requiresApproval as ApprovalFn;
    for (const action of ["create", "update", "delete", "enable", "disable"]) {
      expect(await requiresApproval({ action }, {})).toEqual({
        reason: expect.stringContaining("MCP"),
      });
    }
  });

  it("names duplicate conflicts instead of leaking database text", async () => {
    const { deps, tools } = setup();
    deps.create.mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const output = await tools[0]!.call({
      action: "create",
      name: "docs",
      url: "https://mcp.example.com/mcp",
      authType: "none",
    });
    expect(normalizeToolResultOutput(output)).toEqual({
      type: "json",
      value: { ok: false, error: expect.stringContaining("already exists") },
    });
  });

  it("rejects unknown arg keys before any service runs", async () => {
    const { deps, tools } = setup();
    await expect(
      tools[0]!.call({ action: "list", token: "sk-x" }),
    ).rejects.toThrow();
    expect(deps.list).not.toHaveBeenCalled();
  });
});

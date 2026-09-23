import { normalizeToolResultOutput } from "@anvia/core/tool";
import { describe, expect, it, vi } from "vitest";
import {
  USER_SKILL_TOOL_DEFINITIONS,
  createUserSkillsTools,
} from "./user-skills.js";

function setup() {
  const deps = {
    userId: "u1",
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: "s1", name: "brief" })),
    update: vi.fn(async () => ({ id: "s1" })),
    remove: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
  };
  return { deps, tools: createUserSkillsTools(deps) };
}

type ApprovalFn = (
  args: Record<string, unknown>,
  context: unknown,
) => Promise<false | { reason: string }>;

describe("manage_user_skills", () => {
  it("registers one tool with a frozen definition", () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual(["manage_user_skills"]);
    expect(USER_SKILL_TOOL_DEFINITIONS.map((def) => def.name)).toEqual([
      "manage_user_skills",
    ]);
  });

  it("requires approval for create but not for list", async () => {
    const { tools } = setup();
    const requiresApproval = tools[0]!.requiresApproval as ApprovalFn;
    expect(
      await requiresApproval(
        { action: "create", name: "x", description: "d", bodyMd: "b" },
        {},
      ),
    ).toEqual({ reason: expect.stringContaining("skill") });
    expect(await requiresApproval({ action: "list" }, {})).toBe(false);
  });

  it("creates through deps and returns the stripped identity", async () => {
    const { deps, tools } = setup();
    const output = await tools[0]!.call({
      action: "create",
      name: "brief",
      description: "d",
      bodyMd: "---\nname: brief\ndescription: d\n---\nb",
    });
    expect(deps.create).toHaveBeenCalledWith({
      name: "brief",
      description: "d",
      bodyMd: expect.stringContaining("brief"),
      status: "draft",
    });
    expect(normalizeToolResultOutput(output)).toEqual({
      type: "json",
      value: { ok: true, id: "s1", name: "brief", draft: true },
    });
  });

  it("maps service errors to bounded results, never throws", async () => {
    const { deps, tools } = setup();
    deps.create.mockRejectedValueOnce(new Error("Skill limit reached (20 active)"));
    const output = await tools[0]!.call({
      action: "create",
      name: "x",
      description: "d",
      bodyMd: "b",
    });
    expect(normalizeToolResultOutput(output)).toEqual({
      type: "json",
      value: { ok: false, error: expect.stringContaining("Skill limit") },
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

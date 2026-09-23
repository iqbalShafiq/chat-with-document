import { createTool, type AnyTool } from "@anvia/core";
import z, { type JSONType } from "zod";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";

export type UserSkillsToolDeps = {
  userId: string;
  list(): Promise<
    { id: string; name: string; description: string; isEnabled: boolean; status: string }[]
  >;
  create(input: {
    name: string;
    description: string;
    bodyMd: string;
    status?: "draft";
  }): Promise<{ id: string; name: string }>;
  update(
    id: string,
    input: { name: string; description: string; bodyMd: string },
  ): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, isEnabled: boolean): Promise<void>;
};

const manageUserSkillsInput = z
  .object({
    action: z.enum(["list", "create", "update", "delete", "enable", "disable"]),
    skillId: z.string().max(256).optional(),
    name: z.string().max(70).optional(),
    description: z.string().max(1100).optional(),
    bodyMd: z.string().max(17000).optional(),
  })
  .strict();

const manageUserSkillsSpec = {
  name: "manage_user_skills",
  description:
    "Manage the user's reusable skills (procedures the agent loads when a task fits). " +
    "Use list to see them; create/update/delete/enable/disable change them. " +
    "Created skills start as drafts the user reviews in the Skills modal — tell the user that. " +
    "bodyMd MUST be a complete SKILL.md starting with YAML frontmatter between --- lines, " +
    'for example: ---\\nname: my-skill\\ndescription: When to use it.\\n---\\n\\n# My skill\\n\\nSteps. ' +
    "The frontmatter name: and description: must equal the name and description fields, or the call fails. " +
    "Never invent secrets: this tool takes no tokens or credentials.",
  inputSchema: manageUserSkillsInput,
} as const;

export const USER_SKILL_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(manageUserSkillsSpec),
];

const NO_APPROVAL_ACTIONS: ReadonlySet<string> = new Set(["list"]);

export function createUserSkillsTools(deps: UserSkillsToolDeps): AnyTool[] {
  return [
    createTool({
      ...manageUserSkillsSpec,
      outputSchema: z.json(),
      requiresApproval: async (args) =>
        NO_APPROVAL_ACTIONS.has(args.action)
          ? false
          : { reason: `Approve managing a user skill (${args.action})` },
      execute: async (args, context): Promise<JSONType> => {
        try {
          context.abortSignal?.throwIfAborted();
          switch (args.action) {
            case "list": {
              const skills = await deps.list();
              return { ok: true, skills };
            }
            case "create": {
              const created = await deps.create({
                name: args.name ?? "",
                description: args.description ?? "",
                bodyMd: args.bodyMd ?? "",
                status: "draft",
              });
              return { ok: true, ...created, draft: true };
            }
            case "update": {
              if (!args.skillId) return { ok: false, error: "skillId is required to update" };
              const updated = await deps.update(args.skillId, {
                name: args.name ?? "",
                description: args.description ?? "",
                bodyMd: args.bodyMd ?? "",
              });
              return { ok: true, ...updated };
            }
            case "delete": {
              if (!args.skillId) return { ok: false, error: "skillId is required to delete" };
              await deps.remove(args.skillId);
              return { ok: true };
            }
            case "enable":
            case "disable": {
              if (!args.skillId) return { ok: false, error: "skillId is required" };
              await deps.setEnabled(args.skillId, args.action === "enable");
              return { ok: true };
            }
          }
        } catch (error) {
          context.abortSignal?.throwIfAborted();
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, error: message };
        }
      },
    }),
  ];
}

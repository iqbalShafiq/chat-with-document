import { createTool, type AnyTool } from "@anvia/core";
import z, { type JSONType } from "zod";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";

export type UserMcpToolDeps = {
  userId: string;
  list(): Promise<
    {
      id: string;
      name: string;
      url: string;
      authType: string;
      isEnabled: boolean;
      status: string;
      allowedTools: string[];
    }[]
  >;
  create(input: {
    name: string;
    url: string;
    authType: "none" | "bearer";
  }): Promise<{ id: string; name: string }>;
  update(
    id: string,
    input: { name: string; url: string; authType: "none" | "bearer" },
  ): Promise<{ id: string }>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, isEnabled: boolean): Promise<void>;
  test(input: {
    url: string;
    authType: "none" | "bearer";
  }): Promise<{ ok: boolean; tools?: { name: string }[]; error?: string }>;
};

const authTypeSchema = z.enum(["none", "bearer"]);

const manageUserMcpInput = z
  .object({
    action: z.enum(["list", "create", "update", "delete", "enable", "disable", "test"]),
    serverId: z.string().max(256).optional(),
    name: z.string().max(70).optional(),
    url: z.string().max(520).optional(),
    authType: authTypeSchema.optional(),
  })
  .strict();

const manageUserMcpSpec = {
  name: "manage_user_mcp_servers",
  description:
    "Manage the user's MCP servers (external tools over Streamable HTTP). " +
    "Use list to see them; test checks a URL without saving; create/update/delete/enable/disable change them. " +
    "A saved server only runs after the user tests it in the MCP modal — tell the user that. " +
    "Never invent secrets: this tool takes no tokens, header values, or credentials.",
  inputSchema: manageUserMcpInput,
} as const;

export const USER_MCP_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(manageUserMcpSpec),
];

const NO_APPROVAL_ACTIONS: ReadonlySet<string> = new Set(["list", "test"]);

export function createUserMcpTools(deps: UserMcpToolDeps): AnyTool[] {
  return [
    createTool({
      ...manageUserMcpSpec,
      outputSchema: z.json(),
      requiresApproval: async (args) =>
        NO_APPROVAL_ACTIONS.has(args.action)
          ? false
          : { reason: `Approve managing an MCP server (${args.action})` },
      execute: async (args, context): Promise<JSONType> => {
        try {
          context.abortSignal?.throwIfAborted();
          switch (args.action) {
            case "list": {
              const servers = await deps.list();
              return { ok: true, servers };
            }
            case "test": {
              if (!args.url) return { ok: false, error: "url is required to test" };
              return await deps.test({
                url: args.url,
                authType: args.authType ?? "none",
              });
            }
            case "create": {
              const created = await deps.create({
                name: args.name ?? "",
                url: args.url ?? "",
                authType: args.authType ?? "none",
              });
              return { ok: true, ...created, untested: true };
            }
            case "update": {
              if (!args.serverId) return { ok: false, error: "serverId is required to update" };
              const updated = await deps.update(args.serverId, {
                name: args.name ?? "",
                url: args.url ?? "",
                authType: args.authType ?? "none",
              });
              return { ok: true, ...updated };
            }
            case "delete": {
              if (!args.serverId) return { ok: false, error: "serverId is required to delete" };
              await deps.remove(args.serverId);
              return { ok: true };
            }
            case "enable":
            case "disable": {
              if (!args.serverId) return { ok: false, error: "serverId is required" };
              await deps.setEnabled(args.serverId, args.action === "enable");
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

import { z } from "zod";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";

const manageTasksSpec = {
  name: "manage_tasks",
  description: "Create, list, and update scoped workspace tasks. Updates mutate the same task, never duplicate.",
  inputSchema: z.object({
    action: z.enum(["create", "list", "update"]),
    title: z.string().max(200).optional(),
    id: z.string().optional(),
    status: z.enum(["inbox", "doing", "done"]).optional(),
  }),
} as const;

const manageSchedulesSpec = {
  name: "manage_schedules",
  description: "Create, list, and cancel scoped schedules (once, daily, weekly).",
  inputSchema: z.object({
    action: z.enum(["create", "list", "cancel"]),
    title: z.string().max(200).optional(),
    prompt: z.string().max(4000).optional(),
    freq: z.enum(["once", "daily", "weekly"]).optional(),
    id: z.string().optional(),
  }),
} as const;

export const WORKSPACE_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(manageTasksSpec),
  createStaticToolDefinition(manageSchedulesSpec),
];

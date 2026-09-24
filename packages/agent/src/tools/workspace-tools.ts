import { z } from "zod";
import { createTool, type AnyTool } from "@anvia/core";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";

const manageTasksSpec = {
  name: "manage_tasks",
  description:
    "Create, list, and update scoped workspace tasks. A task has a title, optional description, status (inbox/doing/done), and a subtask checklist — add subtasks with addSubtasks, flip them with toggleSubtasks, remove with removeSubtasks. Updates mutate the same task, never duplicate.",
  inputSchema: z.object({
    action: z.enum(["create", "list", "update"]),
    title: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    id: z.string().optional(),
    status: z.enum(["inbox", "doing", "done"]).optional(),
    addSubtasks: z.array(z.string().max(200)).max(50).optional(),
    toggleSubtasks: z
      .array(z.object({ id: z.string(), done: z.boolean() }))
      .max(50)
      .optional(),
    removeSubtasks: z.array(z.string()).max(50).optional(),
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

export function createWorkspaceManageTools(deps: {
  tasks: {
    list(): Promise<unknown>;
    create(input: { title: string; description?: string; addSubtasks?: string[] }): Promise<{ id: string }>;
    update(input: {
      id: string;
      status?: string;
      title?: string;
      description?: string | null;
      addSubtasks?: string[];
      toggleSubtasks?: { id: string; done: boolean }[];
      removeSubtasks?: string[];
    }): Promise<unknown>;
  };
  schedules: {
    list(): Promise<unknown>;
    create(input: { title: string; prompt: string; freq: string }): Promise<{ id: string }>;
    cancel(input: { id: string }): Promise<unknown>;
  };
  onFocus?: (input: { artifactId: string; artifactType: "task" | "schedule"; label?: string }) => void;
}): AnyTool[] {
  const jsonOutputSchema = z.json();
  type JsonOutput = z.output<typeof jsonOutputSchema>;
  const toJson = (value: unknown): JsonOutput => jsonOutputSchema.parse(JSON.parse(JSON.stringify(value)));
  const manageTasks = createTool({
    ...manageTasksSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ action, title, description, id, status, addSubtasks, toggleSubtasks, removeSubtasks }): Promise<JsonOutput> => {
      if (action === "list") return toJson(await deps.tasks.list());
      if (action === "create") {
        if (!title) throw new Error("Title is required to create a task.");
        const created = await deps.tasks.create({
          title,
          ...(description ? { description } : {}),
          ...(addSubtasks ? { addSubtasks } : {}),
        });
        deps.onFocus?.({ artifactId: created.id, artifactType: "task", label: title });
        return toJson(created);
      }
      if (!id) throw new Error("Id is required to update a task.");
      return toJson(
        await deps.tasks.update({
          id,
          ...(status ? { status } : {}),
          ...(title ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(addSubtasks ? { addSubtasks } : {}),
          ...(toggleSubtasks ? { toggleSubtasks } : {}),
          ...(removeSubtasks ? { removeSubtasks } : {}),
        }),
      );
    },
  });
  const manageSchedules = createTool({
    ...manageSchedulesSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ action, title, prompt, freq, id }): Promise<JsonOutput> => {
      if (action === "list") return toJson(await deps.schedules.list());
      if (action === "create") {
        if (!title || !prompt || !freq) throw new Error("Title, prompt, and freq are required.");
        const created = await deps.schedules.create({ title, prompt, freq });
        deps.onFocus?.({ artifactId: created.id, artifactType: "schedule", label: title });
        return toJson(created);
      }
      if (!id) throw new Error("Id is required to cancel a schedule.");
      return toJson(await deps.schedules.cancel({ id }));
    },
  });
  return [manageTasks, manageSchedules];
}

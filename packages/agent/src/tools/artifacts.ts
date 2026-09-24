import { z } from "zod";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";

const listArtifactsSpec = {
  name: "list_artifacts",
  description:
    "List workspace artifacts in the current session scope (standalone sees only standalone, project sees only that project). Filter by type and search query.",
  inputSchema: z.object({
    type: z.enum(["document", "image", "web_bundle", "task", "schedule", "session"]).optional(),
    q: z.string().max(200).optional(),
  }),
} as const;

const findImagesSpec = {
  name: "find_images",
  description:
    "Search image assets by caption or prompt within scope. Returns ids usable in reports and sites.",
  inputSchema: z.object({
    query: z.string().min(1).max(200),
    limit: z.number().int().min(1).max(20).optional().default(5),
  }),
} as const;

const listSessionsSpec = {
  name: "list_sessions",
  description: "List sibling chat sessions in the same scope (read-only summaries).",
  inputSchema: z.object({
    q: z.string().max(200).optional(),
  }),
} as const;

export const ARTIFACT_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(listArtifactsSpec),
  createStaticToolDefinition(findImagesSpec),
  createStaticToolDefinition(listSessionsSpec),
];

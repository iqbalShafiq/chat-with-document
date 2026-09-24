import { z } from "zod";
import { createTool, type AnyTool } from "@anvia/core";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";

const listArtifactsSpec = {
  name: "list_artifacts",
  description:
    "List workspace artifacts in the current session scope (standalone sees only standalone, project sees only that project). Filter by type and search query.",
  inputSchema: z.object({
    type: z.enum(["document", "image", "site", "web_bundle", "task", "schedule", "session"]).optional(),
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

const getArtifactSpec = {
  name: "get_artifact",
  description:
    "Fetch one artifact's full detail by type and id (detail-on-demand after listing). Out-of-scope ids yield not-found.",
  inputSchema: z.object({
    type: z.enum(["document", "image", "site", "web_bundle", "task", "schedule", "session"]),
    id: z.string().min(1).max(120),
  }),
} as const;

const getSessionExcerptSpec = {
  name: "get_session_excerpt",
  description:
    "Read the last turns of a sibling session in the same scope (bounded excerpt, never a full dump).",
  inputSchema: z.object({
    sessionId: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(20).optional().default(6),
  }),
} as const;

export const ARTIFACT_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(listArtifactsSpec),
  createStaticToolDefinition(findImagesSpec),
  createStaticToolDefinition(listSessionsSpec),
  createStaticToolDefinition(getArtifactSpec),
  createStaticToolDefinition(getSessionExcerptSpec),
];

/**
 * Convention for visual artifact choices in request_clarification:
 * choice values shaped `artifact:<type>:<id>` render as visual pickers
 * in the UI and are submitted back verbatim. The protocol is unchanged
 * (label/value strings) — only the value shape is contractual.
 */
export const ARTIFACT_CHOICE_PREFIX = "artifact:";

export function encodeArtifactChoice(
  type: "document" | "image" | "web_bundle" | "site" | "task" | "schedule" | "session",
  id: string,
): string {
  return `${ARTIFACT_CHOICE_PREFIX}${type}:${id}`;
}

export function decodeArtifactChoice(value: string): {
  type: string;
  id: string;
} | null {
  if (!value.startsWith(ARTIFACT_CHOICE_PREFIX)) return null;
  const rest = value.slice(ARTIFACT_CHOICE_PREFIX.length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return null;
  return { type: rest.slice(0, sep), id: rest.slice(sep + 1) };
}

export const ARTIFACT_CHOICE_INSTRUCTION = [
  "When you are unsure which artifact the user means (image, site, document, task),",
  "ask via request_clarification with one choice per candidate shaped exactly",
  "`artifact:<type>:<id>` (type is document|image|web_bundle|site|task|schedule|session).",
  "The UI renders those choices as visual pickers and returns the value verbatim;",
  "decode it and act on that artifact id. Never invent ids.",
].join(" ");

export type ArtifactFocusHandler = (input: {
  artifactId: string;
  artifactType: "document" | "image" | "web_bundle" | "site" | "task" | "schedule" | "session";
  label?: string;
}) => void;

const jsonOutputSchema = z.json();

type JsonOutput = z.output<typeof jsonOutputSchema>;

function toJson<T>(value: T): JsonOutput {
  return jsonOutputSchema.parse(JSON.parse(JSON.stringify(value)));
}

export type ArtifactServiceDeps = {
  list(input: { type?: string; q?: string }): Promise<{ items: unknown[] }>;
  get(input: { type: string; id: string }): Promise<unknown>;
  getExcerpt(input: { sessionId: string; limit: number }): Promise<unknown>;
};

export function createArtifactTools(
  deps: ArtifactServiceDeps & { onFocus?: ArtifactFocusHandler },
): AnyTool[] {
  const listArtifacts = createTool({
    ...listArtifactsSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ type, q }): Promise<JsonOutput> => {
      return toJson(
        await deps.list({
          ...(type ? { type } : {}),
          ...(q ? { q } : {}),
        }),
      );
    },
  });
  const findImages = createTool({
    ...findImagesSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ query, limit }): Promise<JsonOutput> => {
      const result = await deps.list({ type: "image", q: query });
      const items = (result.items as unknown[]).slice(0, limit);
      const first = items[0] as { id?: string } | undefined;
      if (first?.id) {
        deps.onFocus?.({ artifactId: first.id, artifactType: "image" });
      }
      return toJson({ images: items });
    },
  });
  const listSessions = createTool({
    ...listSessionsSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ q }): Promise<JsonOutput> => {
      return toJson(
        await deps.list({
          type: "session",
          ...(q ? { q } : {}),
        }),
      );
    },
  });
  const getArtifact = createTool({
    ...getArtifactSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ type, id }): Promise<JsonOutput> => {
      const artifact = await deps.get({ type, id });
      if (!artifact) throw new Error("Artifact not found in the current scope.");
      return toJson(artifact);
    },
  });
  const getSessionExcerpt = createTool({
    ...getSessionExcerptSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ sessionId, limit }): Promise<JsonOutput> => {
      const excerpt = await deps.getExcerpt({ sessionId, limit });
      if (!excerpt) throw new Error("Session not found in the current scope.");
      return toJson(excerpt);
    },
  });
  return [listArtifacts, findImages, listSessions, getArtifact, getSessionExcerpt];
}

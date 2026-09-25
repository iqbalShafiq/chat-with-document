import { z } from "zod";
import { createTool, type AnyTool } from "@anvia/core";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";
import type { ArtifactFocusHandler } from "./artifacts.js";

const viewSitePageInput = z.object({
  siteId: z
    .string()
    .min(1)
    .max(120)
    .describe("Site id from a pin or list_artifacts (type site)"),
  version: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Site version to view. Omit to use the current stable version."),
  question: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("What to focus on, e.g. 'review the hero section design'"),
});

const viewSitePageSpec = {
  name: "view_site_page",
  description:
    "View a workspace site's content and appearance. Always returns a bounded text excerpt plus provenance (siteId, version, imageId, capturedAt). Vision models receive the screenshot bytes directly; text-only models must pass imageId to view_image for a description. Never ask the user for screenshots.",
  inputSchema: viewSitePageInput,
} as const;

export const SITE_VIEW_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(viewSitePageSpec),
];

const jsonOutputSchema = z.json();

type JsonOutput = z.output<typeof jsonOutputSchema>;

function toJson<T>(value: T): JsonOutput {
  return jsonOutputSchema.parse(JSON.parse(JSON.stringify(value)));
}

export type ViewSitePageResult = {
  siteId: string;
  version: number;
  status: string;
  title: string;
  headings: string[];
  excerpt: string;
  excerptTruncated: boolean;
  imageId: string;
  capturedAt: string;
  viewport: { width: number; height: number };
  fullPage: boolean;
  truncated: boolean;
};

export function createViewSitePageTools(
  deps: {
    view: (input: { siteId: string; version?: number; question?: string }) => Promise<ViewSitePageResult>;
    onFocus?: ArtifactFocusHandler;
  },
): AnyTool[] {
  const viewSitePage = createTool({
    ...viewSitePageSpec,
    outputSchema: jsonOutputSchema,
    execute: async ({ siteId, version, question }): Promise<JsonOutput> => {
      const result = await deps.view({
        siteId,
        ...(version !== undefined ? { version } : {}),
        ...(question !== undefined ? { question } : {}),
      });
      deps.onFocus?.({ artifactId: result.siteId, artifactType: "site", label: result.title });
      return toJson(result);
    },
  });
  return [viewSitePage];
}

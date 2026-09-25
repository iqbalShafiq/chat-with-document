import { z } from "zod";
import { createTool, type AnyTool, type ToolResultContentPart } from "@anvia/core";
import { ToolOutput } from "@anvia/core/tool";
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
    /**
     * Vision models receive the screenshot bytes inline (mirrors
     * get_document_page_images). Text-only models get JSON only and resolve
     * the image via view_image. Defaults to true.
     */
    includeImageBytes?: boolean;
    loadImageBytes?: (imageId: string) => Promise<{ buffer: Uint8Array; mediaType: string }>;
  },
): AnyTool[] {
  const viewSitePage = createTool({
    ...viewSitePageSpec,
    execute: async ({ siteId, version, question }) => {
      const result = await deps.view({
        siteId,
        ...(version !== undefined ? { version } : {}),
        ...(question !== undefined ? { question } : {}),
      });
      deps.onFocus?.({ artifactId: result.siteId, artifactType: "site", label: result.title });
      const bytesIncluded = deps.includeImageBytes !== false;
      const content: ToolResultContentPart[] = [
        {
          type: "text",
          text: JSON.stringify({ ...result, imageBytesIncluded: bytesIncluded }),
        },
      ];
      if (bytesIncluded && deps.loadImageBytes) {
        try {
          const image = await deps.loadImageBytes(result.imageId);
          content.push({
            type: "file",
            data: {
              type: "data",
              data: Buffer.from(image.buffer).toString("base64"),
            },
            mediaType: image.mediaType,
            filename: result.imageId,
          });
        } catch {
          // Bytes are best-effort; the JSON text still carries imageId.
        }
      }
      return ToolOutput.content(content);
    },
  });
  return [viewSitePage];
}

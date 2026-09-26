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
    /**
     * Vision models see the screenshot via the run's pending vision buffer
     * (same mechanism as web_search images): the tool itself stays JSON-only
     * because file parts on tool results do not survive every provider path
     * (chat completions renders them as `[file:…]` placeholders, and repeated
     * toolCallIds collide). Text-only models get JSON only and resolve the
     * image via view_image. Defaults to true.
     */
    includeImageBytes?: boolean;
    /**
     * Queue the screenshot for native vision input on the next model turn.
     * Implemented server-side (loads bytes from the image store into the
     * run's pending vision buffer). Rejects when the bytes are unavailable.
     */
    pushVisionImage?: (image: { imageId: string }) => Promise<void> | void;
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
      let imageBytesIncluded = false;
      if (result.imageId && deps.includeImageBytes !== false && deps.pushVisionImage) {
        try {
          await deps.pushVisionImage({ imageId: result.imageId });
          imageBytesIncluded = true;
        } catch (error) {
          console.warn(
            `[site-viewing] vision queue skipped for ${result.imageId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { ...result, imageBytesIncluded };
    },
  });
  return [viewSitePage];
}

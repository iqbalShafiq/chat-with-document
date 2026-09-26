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

const browseSiteInput = z.object({
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
    .describe("Site version to browse. Omit to use the current stable version."),
  action: z
    .enum(["open", "scroll", "click", "snapshot", "close"])
    .describe("One action per call. open starts the session; close ends it."),
  selector: z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("click only: CSS selector of the target element."),
  text: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("click only: visible text of the target element (first match)."),
  to: z
    .enum(["top", "bottom"])
    .optional()
    .describe("scroll only: jump to the top or bottom instead of one viewport."),
});

const browseSiteSpec = {
  name: "browse_site",
  description:
    "Browse a workspace site interactively: open a live session, then scroll or click one step at a time. Every action returns a fresh screenshot (imageId) plus page title/url; vision models receive the pixels, text-only models pass imageId to view_image. Call snapshot before concluding and close when done. Links that leave the local preview origin are blocked. Never ask the user for screenshots.",
  inputSchema: browseSiteInput,
} as const;

export const SITE_VIEW_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(viewSitePageSpec),
  createStaticToolDefinition(browseSiteSpec),
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

export type BrowseSiteResult = {
  siteId: string;
  version: number;
  action: "open" | "scroll" | "click" | "snapshot" | "close";
  title: string;
  url: string;
  imageId: string;
  blocked: boolean;
  note: string | null;
  actionsUsed: number;
  actionsRemaining: number;
  sessionState: "open" | "closed";
  captureError: string | null;
  retryable: boolean;
};

export function createBrowseSiteTools(deps: {
  act: (input: {
    siteId: string;
    version?: number;
    action: BrowseSiteResult["action"];
    selector?: string;
    text?: string;
    to?: "top" | "bottom";
  }) => Promise<BrowseSiteResult>;
  onFocus?: ArtifactFocusHandler;
  /** Mirrors createViewSitePageTools: vision models get bytes, text-only do not. */
  includeImageBytes?: boolean;
  pushVisionImage?: (image: { imageId: string }) => Promise<void> | void;
}): AnyTool[] {
  const browseSite = createTool({
    ...browseSiteSpec,
    execute: async ({ siteId, version, action, selector, text, to }) => {
      const result = await deps.act({
        siteId,
        ...(version !== undefined ? { version } : {}),
        action,
        ...(selector !== undefined ? { selector } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(to !== undefined ? { to } : {}),
      });
      if (action === "open") {
        deps.onFocus?.({ artifactId: result.siteId, artifactType: "site", label: result.title });
      }
      let imageBytesIncluded = false;
      if (result.imageId && deps.includeImageBytes !== false && deps.pushVisionImage) {
        try {
          await deps.pushVisionImage({ imageId: result.imageId });
          imageBytesIncluded = true;
        } catch (error) {
          console.warn(
            `[browse-site] vision queue skipped for ${result.imageId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return { ...result, imageBytesIncluded };
    },
  });
  return [browseSite];
}

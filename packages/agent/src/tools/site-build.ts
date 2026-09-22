import { createTool, type AnyTool } from "@anvia/core";
import { z } from "zod";
import { parseSiteBrief, siteBriefSchema, type SiteBrief } from "../sites/site-plan.js";
import {
  createStaticToolDefinition,
  type ToolDefinition,
} from "./static-definition.js";

export type SiteBuildProposal =
  | { action: "create"; brief: SiteBrief; reason?: "no-active-site" | "different-topic" }
  | {
      action: "ask";
      brief: SiteBrief;
      activeSite: { siteId: string; siteName: string };
      question: string;
      choices: { id: string; label: string }[];
      recommendation: "iterate";
    }
  | { action: "error"; message: string };

export type SiteBuildToolDeps = {
  parseBrief: typeof parseSiteBrief;
  readActiveSite: (sessionId: string) => Promise<{ siteId: string; siteName: string } | null>;
  enqueueBuild: (input: {
    siteId: string | null;
    sessionId: string;
    userId: string;
    prompt: string;
    brief: SiteBrief;
  }) => Promise<{ siteId: string; version: number }>;
};

const proposeInput = z.object({
  prompt: z.string().min(1).max(2000).describe("The user's site request, verbatim."),
});

const confirmInput = z.object({
  brief: siteBriefSchema.describe("The brief returned by propose_site_build, unchanged."),
  mode: z.enum(["iterate", "new-site"]).describe("iterate adds a version to activeSiteId; new-site starts fresh."),
  activeSiteId: z.string().min(1).max(120).optional().describe("Required when mode is iterate."),
});

const proposeSiteBuildSpec = {
  name: "propose_site_build",
  description:
    "Decide how to handle a static-website request: create fresh or iterate the session's active site. Never builds anything itself.",
  inputSchema: proposeInput,
} as const;

const confirmSiteBuildSpec = {
  name: "confirm_site_build",
  description: "Enqueue the site build decided via propose_site_build (and clarification when asked).",
  inputSchema: confirmInput,
} as const;

export const SITE_BUILD_TOOL_DEFINITIONS: ToolDefinition[] = [
  createStaticToolDefinition(proposeSiteBuildSpec),
  createStaticToolDefinition(confirmSiteBuildSpec),
];

export const SITE_BUILD_TOOL_INSTRUCTIONS = [
  "You have propose_site_build and confirm_site_build for static-website requests.",
  "Always call propose_site_build first. After it returns action ask, call request_clarification with its question and choices verbatim, then call confirm_site_build with the user's pick (iterate plus that activeSiteId, or new-site).",
  "Never enqueue without confirm. Never invent siteIds.",
].join("\n");

export function createSiteBuildTools(deps: SiteBuildToolDeps): AnyTool[] {
  const propose = createTool({
    ...proposeSiteBuildSpec,
    execute: async ({ prompt }, context) => {
      const session = context as { sessionId?: string; userId?: string };
      try {
        const { brief } = await deps.parseBrief({
          model: (context as { model?: never }).model as never,
          modelId: "site-build",
          prompt,
        });
        const activeSite = await deps.readActiveSite(session.sessionId ?? "");
        if (!activeSite) return { action: "create", brief, reason: "no-active-site" } as const;
        if (activeSite.siteName.trim().toLowerCase() !== brief.siteName.trim().toLowerCase()) {
          return { action: "create", brief, reason: "different-topic" } as const;
        }
        return {
          action: "ask",
          brief,
          activeSite,
          question: `Iterate "${activeSite.siteName}" sebagai versi baru, atau mulai situs baru?`,
          choices: [
            { id: "iterate", label: `Iterate ${activeSite.siteName} (versi baru)` },
            { id: "new-site", label: "Mulai situs baru" },
          ],
          recommendation: "iterate",
        } as const;
      } catch (error) {
        return {
          action: "error",
          message: error instanceof Error ? error.message.slice(0, 500) : String(error),
        } as const;
      }
    },
  });

  const confirm = createTool({
    ...confirmSiteBuildSpec,
    execute: async ({ brief, mode, activeSiteId }, context) => {
      const session = context as { sessionId?: string; userId?: string; originalPrompt?: string };
      if (mode === "iterate" && !activeSiteId) {
        throw new Error("activeSiteId is required to iterate");
      }
      return deps.enqueueBuild({
        siteId: mode === "iterate" ? (activeSiteId as string) : null,
        sessionId: session.sessionId ?? "",
        userId: session.userId ?? "",
        prompt: session.originalPrompt ?? brief.siteName,
        brief,
      });
    },
  });

  return [propose, confirm];
}

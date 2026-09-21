import type { AnyTool, CompletionModel } from "@anvia/core";
import { createAgent, type Agent } from "../agent.js";
import type { SiteBrief } from "./site-plan.js";

export const SITE_BUILDER_MAX_TURNS = 30;

export const SITE_BUILDER_INSTRUCTIONS = [
  "You build static websites inside a sandboxed workspace rooted at /workspace/site.",
  "Work section by section in the order given. One tool-call batch per section.",
  "Write real copy from the brief. Never emit lorem ipsum or placeholder text.",
  "Static output only: HTML, CSS, and client JS. No backend, no database, no secrets, no network calls at runtime.",
  "Only use these commands: npm, npx, node. Never run shells, curl, wget, or ssh.",
  "Finish by running the production build so /workspace/site/dist is fresh.",
].join("\n");

export function buildSiteBuilderPrompt(brief: SiteBrief): string {
  const sections = brief.sections.map((section, index) => `${index + 1}. ${section}`).join("\n");
  return [
    `Site name: ${brief.siteName}`,
    `Audience: ${brief.audience}`,
    `Primary call to action: ${brief.cta}`,
    `Design vibe: ${brief.vibe}`,
    "Sections to build in order:",
    sections,
    "Start with section 1. After each section, continue with the next until all are done, then run the production build.",
  ].join("\n");
}

export function createSiteBuilderAgent(input: {
  model?: CompletionModel;
  tools: AnyTool[];
  maxTurns?: number;
}): Agent {
  return createAgent({
    agentId: "site-builder",
    ...(input.model ? { model: input.model } : {}),
    additionalInstructions: [SITE_BUILDER_INSTRUCTIONS],
    additionalTools: input.tools,
    maxTurns: input.maxTurns ?? SITE_BUILDER_MAX_TURNS,
  });
}

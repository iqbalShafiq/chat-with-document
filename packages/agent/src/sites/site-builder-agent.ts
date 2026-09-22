import type { Agent, AnyTool, CompletionModel, MemoryStore, Message } from "@anvia/core";
import type { MemoryScope } from "@anvia/core/memory";
import { createAgent } from "../agent.js";
import type { SiteBrief } from "./site-plan.js";

export const SITE_BUILDER_MAX_TURNS = 30;

export const SITE_BUILDER_INSTRUCTIONS = [
  "You build static websites inside a sandboxed workspace rooted at /workspace/site.",
  "File tool paths are relative to the sandbox workspace root (/workspace): read and write the scaffold under site/ (for example site/src/App.tsx), never with a leading /workspace prefix. Run commands with cwd site.",
  "Work section by section in the order given. One tool-call batch per section.",
  "Write real copy from the brief. Never emit lorem ipsum or placeholder text.",
  "Static output only: HTML, CSS, and client JS. No backend, no database, no secrets, no network calls at runtime.",
  "Never modify package.json, tsconfig.json, or vite.config.ts; write only site content (src/, index.html, tokens.css).",
  "Only use these commands: npm, npx, node. Never run shells, curl, wget, or ssh.",
  "Finish by running the production build so site/dist is fresh.",
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
  memory?: MemoryStore;
}): Agent {
  return createAgent({
    agentId: "site-builder",
    ...(input.model ? { model: input.model } : {}),
    additionalInstructions: [SITE_BUILDER_INSTRUCTIONS],
    additionalTools: input.tools,
    maxTurns: input.maxTurns ?? SITE_BUILDER_MAX_TURNS,
    // One-shot builds stream with a chat session id, which requires a memory
    // store. Builds are stateless across versions, so an ephemeral
    // process-local store is enough (no durability needed).
    memory: input.memory ?? createEphemeralMemoryStore(),
  });
}

/** Process-local append-only store for one-shot agents without durability needs. */
export function createEphemeralMemoryStore(): MemoryStore {
  const messagesByScope = new Map<string, Message[]>();
  const scopeKey = (scope: MemoryScope): string =>
    `${scope.sessionId}::${scope.userId ?? ""}`;
  return {
    async load({ scope }) {
      return messagesByScope.get(scopeKey(scope)) ?? [];
    },
    async append({ scope, messages }) {
      const key = scopeKey(scope);
      messagesByScope.set(key, [...(messagesByScope.get(key) ?? []), ...messages]);
    },
    async clear({ scope }) {
      messagesByScope.delete(scopeKey(scope));
    },
    async recordError() {},
  };
}

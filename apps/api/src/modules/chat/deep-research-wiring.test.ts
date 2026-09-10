import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

function source(file: string): string {
  return readFileSync(resolve(currentDir, file), "utf8");
}

describe("Deep Research server wiring", () => {
  it("round-trips the toggle through the recipe and live reconstruction", () => {
    const input = source("./build-run-input.ts");
    const recipe = source("./run-recipe.ts");

    expect(recipe).toContain("deepResearchEnabled: z.boolean()");
    expect(input).toContain("recipe.features.deepResearchEnabled");
    expect(input).toContain("recipe.capabilities.deepResearchAvailable");
    expect(input).toContain("createDeepResearchTools");
  });

  it("keeps the feature policy on the persisted recipe and stable agent id", () => {
    const queue = source("./run-queue.ts");
    const input = source("./build-run-input.ts");
    const recipe = source("./run-recipe.ts");

    expect(recipe).toContain('CHAT_AGENT_ID = "chat-agent"');
    expect(recipe).toContain("deepResearchEnabled");
    expect(input).toContain("resolveChatAgentRecipe");
    expect(input).toContain("reconstructChatRunInput");
    expect(input).toContain("recipe.features.deepResearchEnabled");
    expect(input).toContain("recipe.agentId");
    expect(queue).toContain("recipe: chatAgentRecipeSchema");
  });

  it("emits lifecycle progress and documents session-aware availability", () => {
    const worker = source("./run-worker.ts");
    const router = source("./router.ts");
    const openapi = source("../../openapi/paths/chat.ts");

    expect(worker).toContain('type: "deep_research_progress"');
    expect(router).toContain("deepResearchAvailable");
    expect(router).toContain("resolveActiveDocuments");
    expect(openapi).toContain("deepResearchEnabled");
    expect(openapi).toContain("deepResearchAvailable");
  });

  it("reports Context7 configuration without opening an MCP transport in the API process", () => {
    const router = source("./router.ts");
    const openapi = source("../../openapi/paths/chat.ts");
    const capabilitiesRoute = router.slice(
      router.indexOf('.get("/capabilities"'),
      router.indexOf('.post("/interactions/:interactionId/stage"'),
    );

    expect(capabilitiesRoute).toContain(
      "context7Configured: isContext7Configured()",
    );
    expect(capabilitiesRoute).not.toContain("context7Available");
    expect(capabilitiesRoute).not.toContain("getContext7McpServer");
    expect(openapi).toContain('"context7Configured"');
    expect(openapi).not.toContain('"context7Available"');
  });

  it("gives the nested researcher the tabular and derived dataset tools", () => {
    const input = source("./build-run-input.ts");

    expect(input).toMatch(
      /const researchTools = boundDeepResearchTools\(\s*\[\s*\.\.\.documentTools,\s*\.\.\.researchWebTools,\s*\.\.\.tabularTools,\s*\.\.\.researchDerivedTools,\s*\.\.\.chartTools,/s,
    );
    expect(input).not.toContain("...createDataAnalysisTools(),");
  });

  it("gives the nested researcher the dataset instruction and derived tools before the parent seal", () => {
    const input = source("./build-run-input.ts");

    expect(input).toContain("createDerivedDatasetTools");
    expect(input).toContain("DERIVED_TOOL_DEFINITIONS");
    expect(input).toContain("DATASET_INSTRUCTION");
    const derivedPush = input.indexOf("...derivedTools");
    const seal = input.indexOf("sealRetrievalAfterDeepResearch(");
    expect(derivedPush).toBeGreaterThan(-1);
    expect(seal).toBeGreaterThan(derivedPush);
  });

  it("seals parent retrieval after Deep Research starts without wrapping nested tools", () => {
    const input = source("./build-run-input.ts");

    expect(input).toContain("createDeepResearchCompletionGuard");
    expect(input).toContain("sealRetrievalAfterDeepResearch");
    expect(input).toContain("completionGuard");
    expect(input).toMatch(
      /boundDeepResearchTools\(\s*\[\s*\.\.\.documentTools/,
    );
    expect(input).toMatch(
      /sealRetrievalAfterDeepResearch\(\s*tools,\s*completionGuard/,
    );
  });
});

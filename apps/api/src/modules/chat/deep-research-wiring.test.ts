import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

function source(file: string): string {
  return readFileSync(resolve(currentDir, file), "utf8");
}

describe("Deep Research server wiring", () => {
  it("round-trips the toggle through router, queue, worker, and run input", () => {
    const router = source("./router.ts");
    const queue = source("./run-queue.ts");
    const worker = source("./run-worker.ts");
    const input = source("./build-run-input.ts");

    expect(router).toContain("body.deepResearchEnabled");
    expect(router).toContain("deepResearchEnabled,");
    expect(queue).toContain("deepResearchEnabled: boolean");
    expect(worker).toContain("deepResearchEnabled,");
    expect(input).toContain("deepResearchEnabled = false");
    expect(input).toContain("createDeepResearchTools");
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

  it("gives the nested researcher the default data-analysis tools", () => {
    const input = source("./build-run-input.ts");

    expect(input).toMatch(
      /const researchTools = boundDeepResearchTools\(\s*\[\s*\.\.\.documentTools,\s*\.\.\.researchWebTools,\s*\.\.\.createDataAnalysisTools\(\),\s*\.\.\.tabularTools,/s,
    );
  });
});

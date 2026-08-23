import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

function source(file: string): string {
  return readFileSync(resolve(currentDir, file), "utf8");
}

describe("Additional features menu", () => {
  it("keeps Data Analysis out of the optional feature controls", () => {
    const popover = source("./features-popover.tsx");
    const composer = source("./chat-composer.tsx");
    const route = source("../../routes/index.tsx");

    expect(popover).not.toContain("dataAnalysis");
    expect(popover).not.toContain("Data analysis");
    expect(composer).not.toContain("dataAnalysis");
    expect(route).not.toContain("dataAnalysisEnabled");
    expect(route).toContain("deepResearchEnabled");
  });
});

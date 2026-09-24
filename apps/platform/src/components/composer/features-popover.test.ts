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
    const session = source("../chat/chat-session.tsx");

    expect(popover).not.toContain("dataAnalysis");
    expect(popover).not.toContain("Data analysis");
    expect(composer).not.toContain("dataAnalysis");
    expect(session).not.toContain("dataAnalysisEnabled");
    expect(session).toContain("deepResearchEnabled");
  });

  it("hosts Skills and MCP rows with counts and manage entry points", () => {
    const popover = source("./features-popover.tsx");
    const composer = source("./chat-composer.tsx");
    const session = source("../chat/chat-session.tsx");

    expect(popover).toContain("skillsSummary");
    expect(popover).toContain("mcpSummary");
    expect(popover).toContain("onOpenSkills");
    expect(popover).toContain("onOpenMcp");
    expect(popover).toContain("CountBadge");
    expect(composer).toContain("skillsSummary");
    expect(session).toContain("activeSkillIds");
    expect(session).toContain("activeMcpIds");
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

function source(file: string): string {
  return readFileSync(resolve(currentDir, file), "utf8");
}

describe("Enhancement modals", () => {
  it("builds both modals on the shared dialog shell and field chrome", () => {
    const skills = source("./skills-modal.tsx");
    const mcp = source("../mcp/mcp-modal.tsx");
    const session = source("../chat/chat-session.tsx");

    for (const modal of [skills, mcp]) {
      expect(modal).toContain("DialogShell");
      expect(modal).toContain("ConfirmDialog");
      expect(modal).toContain("onChanged");
      expect(modal).toContain("InsetScrollbar");
      expect(modal).toContain("chat-scroll-bleed");
      expect(modal).toContain("footer={");
    }
    expect(skills).toContain("Draft");
    expect(skills).toContain("FormTextAreaField");
    expect(mcp).toContain("Test connection");
    expect(session).toContain("SkillsModal");
    expect(session).toContain("McpModal");
  });
});

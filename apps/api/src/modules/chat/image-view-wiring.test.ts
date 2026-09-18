import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("image-view wiring", () => {
  it("registers view_image only for text-only models", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(resolve(currentDir, "./build-run-input.ts"), "utf8");
    expect(content).toContain('...(!modelAcceptsImage ? [VIEW_IMAGE_TOOL_DEFINITIONS.description] : [])');
    expect(content).not.toContain("universalViewImageRegistered");
    expect(content).toContain("createRemoteImageAttacher");
    expect(content).toContain("injectPendingVisionImages");
    expect(content).toContain("WEB_SEARCH_VISION_IMAGE_INSTRUCTION");
    expect(content).toContain("WEB_SEARCH_TEXT_ONLY_IMAGE_INSTRUCTION");
  });

  it("freezes the vision-helper instruction only for text-only models", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(resolve(currentDir, "./build-run-input.ts"), "utf8");
    expect(content).toContain("if (!modelAcceptsImage) {");
    expect(content).toContain("instructions.push(VISION_HELPER_INSTRUCTION);");
    expect(content).toContain("const instructions = [...recipe.instructionFragments];");
    expect(content).not.toContain("if (!modelAcceptsImage || webSearchAvailable)");
  });

  it("reconstructs image settings and capabilities from the frozen recipe", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(resolve(currentDir, "./build-run-input.ts"), "utf8");
    const reconstruction = content.slice(
      content.indexOf("export async function reconstructChatRunInput"),
    );

    expect(reconstruction).toContain("recipe.imageGenSettings");
    expect(reconstruction).toContain("recipe.capabilities.modelAcceptsImage");
    expect(reconstruction).toContain("recipe.activeContext.images");
    expect(reconstruction).not.toContain("listSessionImageContexts");
  });
});

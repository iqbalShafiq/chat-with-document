import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("image-view wiring", () => {
  it("registers view_image for vision model when web search is available (vision mode)", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(resolve(currentDir, "./build-run-input.ts"), "utf8");
    // Must have universal wiring: vision mode when webSearchAvailable
    expect(content).toContain('mode: "vision"');
    expect(content).toContain('webSearchAvailable && !universalViewImageRegistered');
    expect(content).toContain('mode: "description"');
    expect(content).toContain('universalViewImageRegistered');
    // Ensure dummy fallback exists
    expect(content).toContain('makeCompletionModel(model)');
  });

  it("freezes the vision-helper instruction in the recipe", () => {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const content = readFileSync(resolve(currentDir, "./build-run-input.ts"), "utf8");
    // The resolver owns the frozen instruction surface; reconstruction reuses
    // the recipe and only guards duplicate tool registration.
    expect(content).toContain('if (!modelAcceptsImage || webSearchAvailable) {');
    expect(content).toContain('instructions.push(VISION_HELPER_INSTRUCTION);');
    expect(content).toContain('const instructions = [...recipe.instructionFragments];');
    expect(content).not.toContain(
      'if (!universalViewImageRegistered) instructions.push(VISION_HELPER_INSTRUCTION)',
    );
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

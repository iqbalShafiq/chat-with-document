import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = (file: string) =>
  readFileSync(resolve(currentDir, file), "utf8");

describe("run recipe boundaries", () => {
  it("makes context usage explicitly non-consuming", () => {
    const usage = source("./context-usage.ts");
    expect(usage).toContain("resolveChatAgentRecipe");
    expect(usage).toContain("consumeSingleUseContext: false");
    expect(usage).not.toContain("buildChatRunInput");
  });

  it("does not leave a combined resolver/reconstructor", () => {
    const input = source("./build-run-input.ts");
    expect(input).toContain("export async function resolveChatAgentRecipe");
    expect(input).toContain("export async function reconstructChatRunInput");
    expect(input).not.toContain("export async function buildChatRunInput");
  });
});

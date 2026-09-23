import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { CompletionModel } from "@anvia/core";
import { loadSkills, skill } from "@anvia/core/skills";
import { describe, expect, it } from "vitest";
import { createAgent } from "./agent.js";
import { BASE_INSTRUCTIONS } from "./prompts/base-instructions.js";

const model = {
  provider: "test",
  modelId: "test/model",
  completion: async () => {
    throw new Error("not called");
  },
} as unknown as CompletionModel;

async function loadBriefSkillSet() {
  const root = resolve(tmpdir(), `anreal-skills-test-${Date.now()}`);
  await mkdir(resolve(root, "brief-note"), { recursive: true });
  await writeFile(
    resolve(root, "brief-note", "SKILL.md"),
    "---\nname: brief-note\ndescription: Write a brief note.\n---\n\n# Brief note\n\nWrite a short brief.\n",
    "utf8",
  );
  return loadSkills(skill.local(root));
}

describe("createAgent user enhancements", () => {
  it("forwards skills to the native agent", async () => {
    const skillSet = await loadBriefSkillSet();
    const agent = createAgent({ agentId: "test", model, skills: skillSet });
    expect(agent.instructions).toContain("Write a brief note.");
  });

  it("keeps base instructions when no skills are passed", () => {
    const agent = createAgent({ agentId: "test", model });
    expect(agent.instructions).toBe(BASE_INSTRUCTIONS.trim());
  });
});

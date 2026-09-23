import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  materializeRecipeSkills,
  slugForMcpPrefix,
} from "./build-run-input.js";

describe("materializeRecipeSkills", () => {
  it("names each skill directory after its slug for the native loader", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "recipe-skills-"));
    await materializeRecipeSkills(
      [{ id: "cuid123", name: "brief", bodyMd: "---\nname: brief\ndescription: d\n---\nbody" }],
      root,
    );
    const entries = await readdir(root);
    expect(entries).toEqual(["brief"]);
    const content = await readFile(resolve(root, "brief", "SKILL.md"), "utf8");
    expect(content).toContain("name: brief");
  });
});

describe("slugForMcpPrefix", () => {
  it("slugifies names and falls back to the id", () => {
    expect(slugForMcpPrefix("My Docs!", "abc")).toBe("my_docs_");
    expect(slugForMcpPrefix("!!!", "abc")).toBe("abc_");
  });
});

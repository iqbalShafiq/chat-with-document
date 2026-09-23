import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  materializeRecipeSkills,
  slugForMcpPrefix,
  sortToolDefinitionsByName,
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

  it("refuses to write outside the skill root", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "recipe-skills-"));
    await expect(
      materializeRecipeSkills(
        [{ id: "evil", name: "../evil", bodyMd: "---\nname: x\ndescription: d\n---\nb" }],
        root,
      ),
    ).rejects.toThrow("outside the skill root");
  });
});

describe("slugForMcpPrefix", () => {
  it("slugifies names and falls back to the id", () => {
    expect(slugForMcpPrefix("My Docs!", "abc123")).toBe("my_docs_abc123_");
    expect(slugForMcpPrefix("!!!", "abc123")).toBe("abc123_abc123_");
  });

  it("keeps colliding names apart with an id fragment", () => {
    expect(slugForMcpPrefix("My Docs", "id-one-123456")).not.toBe(
      slugForMcpPrefix("my_docs", "id-two-654321"),
    );
  });
});

describe("sortToolDefinitionsByName", () => {
  it("orders frozen and live definitions identically", () => {
    const defs = [
      { name: "zeta", description: "", parameters: {} },
      { name: "alpha", description: "", parameters: {} },
    ];
    expect(sortToolDefinitionsByName(defs).map((def) => def.name)).toEqual([
      "alpha",
      "zeta",
    ]);
    expect(defs[0]?.name).toBe("zeta");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkill, listMcpServers, listSkills } from "./api";

function mockFetchJson(payload: unknown) {
  const json = vi.fn(async () => payload);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json }) as unknown as Response),
  );
  return json;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("user enhancement api client", () => {
  it("lists skills with credentials included", async () => {
    mockFetchJson([]);
    const skills = await listSkills();
    expect(skills).toEqual([]);
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(init.credentials).toBe("include");
  });

  it("lists mcp servers", async () => {
    mockFetchJson([]);
    await expect(listMcpServers()).resolves.toEqual([]);
  });

  it("attaches server issues to save errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            json: async () => ({
              error: "Invalid skill",
              issues: [{ path: "bodyMd", message: "Frontmatter name: must match" }],
            }),
          }) as unknown as Response,
      ),
    );
    const failure = await createSkill({ name: "x", description: "d", bodyMd: "b" }).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { issues?: unknown }).issues).toEqual([
      { path: "bodyMd", message: "Frontmatter name: must match" },
    ]);
  });
});

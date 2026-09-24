import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@anreal/agent", () => ({
  createCompletionModel: (modelId: string) => ({ modelId }),
  parseCompletionModel: (value: unknown) =>
    typeof value === "string" && value.trim() ? value : null,
}));

vi.mock("./queue.js", () => ({
  enqueueSiteBuild: async () => undefined,
}));

import {
  enqueueSiteBuildFromTool,
  getScopedSite,
  listSitesByScope,
} from "./service.js";

const BRIEF = {
  siteName: "Kopi Senja",
  audience: "pecinta kopi",
  cta: "Pesan",
  sections: ["hero", "kontak"],
  vibe: "hangat",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

function useTempDir(): string {
  const temp = mkdtempSync(join(tmpdir(), "sites-scope-"));
  vi.stubEnv("SITE_DATA_DIR", temp);
  return temp;
}

describe("listSitesByScope", () => {
  it("returns empty without an index", async () => {
    const sites = await listSitesByScope("u1", null, {
      dir: "/tmp/anreal-nope-sites",
    });
    expect(sites).toEqual([]);
  });

  it("finds a project site cross-session but not cross-project", async () => {
    const temp = useTempDir();
    const first = await enqueueSiteBuildFromTool(
      {
        siteId: null,
        sessionId: "session-a",
        userId: "u1",
        projectId: "pX",
        prompt: "bikinkan landing",
        brief: BRIEF,
      },
      temp,
    );
    // Same scope, other session: visible (update, not duplicate).
    const same = await listSitesByScope("u1", "pX", { dir: temp });
    expect(same.map((s) => s.siteId)).toEqual([first.siteId]);

    const second = await enqueueSiteBuildFromTool(
      {
        siteId: first.siteId,
        sessionId: "session-b",
        userId: "u1",
        projectId: "pX",
        prompt: "ganti headline",
        brief: BRIEF,
      },
      temp,
    );
    expect(second).toEqual({ siteId: first.siteId, version: 2 });

    // Other project and standalone: invisible.
    await expect(listSitesByScope("u1", "pY", { dir: temp })).resolves.toEqual([]);
    await expect(listSitesByScope("u1", null, { dir: temp })).resolves.toEqual([]);
    await expect(getScopedSite("u1", "pY", first.siteId, temp)).resolves.toBeNull();

    // In scope: manifest readable.
    await expect(getScopedSite("u1", "pX", first.siteId, temp)).resolves.toMatchObject({
      siteId: first.siteId,
      version: 2,
    });
  });
});

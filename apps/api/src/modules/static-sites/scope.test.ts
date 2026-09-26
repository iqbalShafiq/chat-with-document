import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
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
  writeSiteManifest,
  type SiteManifest,
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

describe("legacy scope backfill", () => {
  function legacyManifest(siteId: string, sessionId: string): SiteManifest {
    return {
      siteId,
      sessionId,
      userId: "u1",
      version: 1,
      status: "ready",
      previewUrl: `/api/sites/${siteId}/v1/preview/index.html`,
      downloadPath: null,
      error: null,
      prompt: "legacy",
      brief: null,
      updatedAt: "2026-09-01T00:00:00.000Z",
      stableVersion: 1,
      versions: { 1: { status: "ready", updatedAt: "2026-09-01T00:00:00.000Z" } },
    };
  }

  it("shows legacy sites that only exist in sites-index.json", async () => {
    const temp = useTempDir();
    await writeSiteManifest(legacyManifest("legacy-site", "legacy-session"), temp);
    await writeFile(
      join(temp, "sites-index.json"),
      JSON.stringify({ "legacy-session": { siteId: "legacy-site", siteName: "Legacy Kedai" } }),
      "utf8",
    );
    const resolveSessionProject = async (sessionId: string) =>
      sessionId === "legacy-session" ? null : "pElsewhere";

    const sites = await listSitesByScope("u1", null, { dir: temp, resolveSessionProject });
    expect(sites.map((s) => s.siteId)).toEqual(["legacy-site"]);
    expect(sites[0]!.siteName).toBe("Legacy Kedai");

    await expect(
      getScopedSite("u1", null, "legacy-site", temp, resolveSessionProject),
    ).resolves.toMatchObject({ siteId: "legacy-site" });

    // A different project never sees the standalone legacy site.
    await expect(
      listSitesByScope("u1", "pX", { dir: temp, resolveSessionProject }),
    ).resolves.toEqual([]);
  });

  it("moves a site's scope entry when it is rebuilt from another scope", async () => {
    const temp = useTempDir();
    const first = await enqueueSiteBuildFromTool(
      {
        siteId: null,
        sessionId: "s1",
        userId: "u1",
        projectId: "pA",
        prompt: "x",
        brief: BRIEF,
      },
      temp,
    );
    await enqueueSiteBuildFromTool(
      {
        siteId: first.siteId,
        sessionId: "s2",
        userId: "u1",
        projectId: "pB",
        prompt: "y",
        brief: BRIEF,
      },
      temp,
    );
    await expect(listSitesByScope("u1", "pA", { dir: temp })).resolves.toEqual([]);
    const moved = await listSitesByScope("u1", "pB", { dir: temp });
    expect(moved.map((s) => s.siteId)).toEqual([first.siteId]);
  });

  it("refuses to rebuild another user's site", async () => {
    const temp = useTempDir();
    const first = await enqueueSiteBuildFromTool(
      {
        siteId: null,
        sessionId: "s1",
        userId: "u1",
        projectId: null,
        prompt: "x",
        brief: BRIEF,
      },
      temp,
    );
    await expect(
      enqueueSiteBuildFromTool(
        {
          siteId: first.siteId,
          sessionId: "s2",
          userId: "u2",
          projectId: null,
          prompt: "y",
          brief: BRIEF,
        },
        temp,
      ),
    ).rejects.toThrow(/not found/i);
  });
});

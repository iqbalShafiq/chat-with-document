import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/prisma.js", () => ({
  prisma: {
    chatSession: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const all = [
          { id: "s1", title: "Laporan kopi", projectId: null, updatedAt: new Date() },
          { id: "s2", title: "Riset teh", projectId: null, updatedAt: new Date() },
        ];
        const titleFilter = where.title as { contains?: string } | undefined;
        const q = titleFilter?.contains;
        return q ? all.filter((s) => s.title.toLowerCase().includes(q.toLowerCase())) : all;
      }),
    },
    document: { findMany: vi.fn(async () => []) },
    generatedImage: { findMany: vi.fn(async () => []) },
    webBundle: { findMany: vi.fn(async () => []) },
    workspaceTask: { findMany: vi.fn(async () => []) },
    workspaceSchedule: { findMany: vi.fn(async () => []) },
  },
}));

import { listArtifacts } from "./service.js";

describe("listArtifacts session search", () => {
  it("filters sessions by title query", async () => {
    const result = await listArtifacts({ userId: "u1", sessionProjectId: null, type: "session", q: "kopi" });
    expect(result.items.map((i) => (i as { sessionId: string }).sessionId)).toEqual(["s1"]);
  });
});

vi.mock("../static-sites/service.js", () => ({
  getScopedSite: vi.fn(async () => ({
    siteId: "kedai",
    version: 2,
    stableVersion: 2,
    status: "ready",
    previewUrl: "/api/sites/kedai/v2/preview/index.html",
    projectId: null,
    updatedAt: "2026-09-25T00:00:00.000Z",
  })),
}));

vi.mock("../static-sites/viewing.js", () => ({
  extractSiteExcerpt: vi.fn(async () => ({
    title: "Kedai",
    headings: ["Halo"],
    excerpt: "Halo dunia",
    truncated: false,
  })),
}));

import { getArtifact } from "./service.js";

describe("getArtifact site detail", () => {
  it("includes a bounded excerpt and stableVersion", async () => {
    const artifact = (await getArtifact({
      userId: "u1",
      sessionProjectId: null,
      type: "site",
      id: "kedai",
    })) as unknown as Record<string, unknown>;
    expect(artifact.excerpt).toBe("Halo dunia");
    expect(artifact).toHaveProperty("stableVersion", 2);
  });
});

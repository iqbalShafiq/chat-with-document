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

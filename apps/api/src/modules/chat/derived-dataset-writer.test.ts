import { describe, expect, it, vi } from "vitest";
import { createDerivedDatasetWriter } from "./derived-dataset-writer.js";

const { prismaMock, createDerivedDocumentMock } = vi.hoisted(() => ({
  prismaMock: {
    document: { count: vi.fn(), findUnique: vi.fn() },
  },
  createDerivedDocumentMock: vi.fn(),
}));

vi.mock("../../utils/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../documents/service.js", () => ({
  createDerivedDocument: (...args: unknown[]) => createDerivedDocumentMock(...args),
}));

function setup(statuses: string[]) {
  prismaMock.document.count.mockResolvedValue(0);
  createDerivedDocumentMock.mockResolvedValue({ id: "d1", filename: "f.csv", origin: "created", status: "queued" });
  let calls = 0;
  prismaMock.document.findUnique.mockImplementation(async () => {
    const status = statuses[Math.min(calls, statuses.length - 1)];
    calls += 1;
    return { status, errorMessage: status === "failed" ? "bad csv" : null };
  });
}

describe("derived dataset writer", () => {
  it("waits until the document is ready", async () => {
    setup(["queued", "embedding_processing", "ready"]);
    const writer = createDerivedDatasetWriter({ userId: "u", sessionId: "s", projectId: null, prisma: prismaMock as never, wait: { intervalMs: 0 } });
    const result = await writer.createDerived({
      filename: "a.csv",
      mimeType: "text/csv",
      data: new Uint8Array([1]),
      origin: "created",
    });
    expect(result).toMatchObject({ documentId: "d1", status: "ready" });
    expect(prismaMock.document.findUnique).toHaveBeenCalled();
  });

  it("throws when ingest is still queued after the wait budget", async () => {
    setup(["queued", "queued", "queued"]);
    const writer = createDerivedDatasetWriter({
      userId: "u",
      sessionId: "s",
      projectId: null,
      prisma: prismaMock as never,
      wait: { attempts: 2, intervalMs: 0 },
    });
    await expect(writer.createDerived({
      filename: "a.csv",
      mimeType: "text/csv",
      data: new Uint8Array([1]),
      origin: "created",
    })).rejects.toThrow("still queued");
  });

  it("surfaces ingest failure instead of hanging", async () => {
    setup(["failed"]);
    const writer = createDerivedDatasetWriter({ userId: "u", sessionId: "s", projectId: null, prisma: prismaMock as never, wait: { intervalMs: 0 } });
    await expect(writer.createDerived({
      filename: "a.csv",
      mimeType: "text/csv",
      data: new Uint8Array([1]),
      origin: "created",
    })).rejects.toThrow("ingest failed: bad csv");
  });
});

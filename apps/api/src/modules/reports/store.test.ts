import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  putObject: vi.fn(async () => undefined),
  deleteObject: vi.fn(async () => undefined),
  getObjectBuffer: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
  buildReportPdf: vi.fn(async () => new Uint8Array([37, 80, 68, 70, 45])),
  documentCreate: vi.fn(),
  documentUpdate: vi.fn(),
  documentFindFirst: vi.fn(),
  chatSessionFindFirst: vi.fn(),
  documentSessionCreate: vi.fn(),
}));

vi.mock("../../lib/r2.js", () => ({
  putObject: mocks.putObject,
  deleteObject: mocks.deleteObject,
  getObjectBuffer: mocks.getObjectBuffer,
  buildDocumentR2Key: (userId: string, sessionId: string, documentId: string, filename: string) =>
    `docs/${userId}/${sessionId}/${documentId}/${filename}`,
}));

vi.mock("./service.js", () => ({ buildReportPdf: mocks.buildReportPdf }));

vi.mock("../../utils/prisma.js", () => ({
  prisma: {
    chatSession: { findFirst: mocks.chatSessionFindFirst },
    document: {
      create: mocks.documentCreate,
      update: mocks.documentUpdate,
      findFirst: mocks.documentFindFirst,
    },
    documentSession: { create: mocks.documentSessionCreate },
  },
}));

import { createReport, editReport, getReportFile } from "./store.js";

const { putObject, deleteObject, buildReportPdf } = mocks;
const documentCreate = mocks.documentCreate;
const documentUpdate = mocks.documentUpdate;
const documentFindFirst = mocks.documentFindFirst;
const chatSessionFindFirst = mocks.chatSessionFindFirst;
const documentSessionCreate = mocks.documentSessionCreate;

const EXISTING = {  id: "doc-1",
  filename: "Laporan_lama.pdf",
  r2Key: "docs/u/s/doc-1/Laporan_lama.pdf",
  citationMap: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  chatSessionFindFirst.mockResolvedValue({ id: "s1", projectId: null });
  documentCreate.mockResolvedValue({ id: "doc-1", filename: "Laporan.pdf" });
  documentUpdate.mockResolvedValue({ id: "doc-1", filename: "Laporan.pdf" });
  documentFindFirst.mockResolvedValue(EXISTING);
  documentSessionCreate.mockResolvedValue({});
  buildReportPdf.mockResolvedValue(new Uint8Array([37, 80, 68, 70, 45]));
});

describe("createReport", () => {
  it("persists the frozen source so later edits can reuse it", async () => {
    await createReport({
      userId: "u1",
      sessionId: "s1",
      title: "Laporan",
      markdown: "# Isi",
      svgAssets: ["<svg/>"],
      imageIds: ["img-1"],
    });
    expect(documentCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "report",
          reportSource: { markdown: "# Isi", svgAssets: ["<svg/>"], imageIds: ["img-1"] },
        }),
      }),
    );
  });

  it("cleans up the uploaded PDF when the DB row cannot be created", async () => {
    documentCreate.mockRejectedValueOnce(new Error("db down"));
    await expect(
      createReport({ userId: "u1", sessionId: "s1", title: "Laporan", markdown: "x" }),
    ).rejects.toThrow("db down");
    expect(putObject).toHaveBeenCalledTimes(1);
    const uploadedCall = putObject.mock.calls[0] as unknown as [string, ...unknown[]];
    expect(deleteObject).toHaveBeenCalledWith(uploadedCall[0]);
  });
});

describe("editReport", () => {  it("title-only edits keep the stored markdown", async () => {
    documentFindFirst.mockResolvedValue({
      ...EXISTING,
      reportSource: { markdown: "# Isi lama", svgAssets: ["<svg/>"], imageIds: ["img-1"] },
    });
    await editReport({ userId: "u1", sessionId: "s1", documentId: "doc-1", title: "Judul baru" });
    expect(buildReportPdf).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Judul baru", markdown: "# Isi lama", svgAssets: ["<svg/>"] }),
    );
  });

  it("renames the document when the title changes", async () => {
    documentFindFirst.mockResolvedValue({
      ...EXISTING,
      reportSource: { markdown: "isi" },
    });
    documentUpdate.mockResolvedValueOnce({ id: "doc-1", filename: "Judul_baru.pdf" });
    const out = await editReport({
      userId: "u1",
      sessionId: "s1",
      documentId: "doc-1",
      title: "Judul baru",
    });
    expect(documentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ filename: "Judul_baru.pdf" }),
      }),
    );
    expect(out.filename).toBe("Judul_baru.pdf");
  });

  it("re-fetches stored raster images for a full re-render", async () => {
    documentFindFirst.mockResolvedValue({
      ...EXISTING,
      reportSource: { markdown: "isi", imageIds: ["img-1"] },
    });
    const fetchRasterAssets = vi.fn(async () => [
      { buffer: new Uint8Array([1, 2, 3]), mediaType: "image/png" },
    ]);
    await editReport({
      userId: "u1",
      sessionId: "s1",
      documentId: "doc-1",
      fetchRasterAssets,
    });
    expect(fetchRasterAssets).toHaveBeenCalledWith(["img-1"]);
    expect(buildReportPdf).toHaveBeenCalledWith(
      expect.objectContaining({ rasterAssets: [{ buffer: new Uint8Array([1, 2, 3]), mediaType: "image/png" }] }),
    );
  });
});

describe("getReportFile", () => {
  it("returns bytes only for in-scope ready reports", async () => {
    documentFindFirst.mockResolvedValue({
      ...EXISTING,
      mimeType: "application/pdf",
      status: "ready",
    });
    const out = await getReportFile({ userId: "u1", sessionId: "s1", documentId: "doc-1" });
    expect(out?.filename).toBe("Laporan_lama.pdf");
    expect(out?.bytes).toEqual(new Uint8Array([37, 80, 68, 70]));
  });

  it("returns null for out-of-scope or missing reports", async () => {
    documentFindFirst.mockResolvedValue(null);
    expect(await getReportFile({ userId: "u1", sessionId: "s1", documentId: "x" })).toBeNull();
  });
});
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, putObjectMock, queueAddMock, ensureChatSessionMock } = vi.hoisted(() => ({
  prismaMock: {
    chatSession: { findFirst: vi.fn() },
    document: { create: vi.fn(), findFirst: vi.fn(), update: vi.fn(), aggregate: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(),
  },
  putObjectMock: vi.fn(),
  queueAddMock: vi.fn(),
  ensureChatSessionMock: vi.fn(),
}));

vi.mock("../../utils/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../../lib/r2.js", () => ({
  buildDocumentR2Key: (...parts: string[]) => parts.join("/"),
  putObject: (...args: unknown[]) => putObjectMock(...args),
}));
vi.mock("../../lib/queue.js", () => ({
  getDocumentIngestQueue: () => ({ add: (...args: unknown[]) => queueAddMock(...args) }),
}));
vi.mock("../chat/chat-session.js", () => ({
  ensureChatSession: (...args: unknown[]) => ensureChatSessionMock(...args),
}));

import { createDerivedDocument, prefixDerivedFilename } from "./service.js";

const BASE = { userId: "u1", sessionId: "s1" };

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.chatSession.findFirst.mockResolvedValue({ projectId: null });
  prismaMock.document.aggregate.mockResolvedValue({ _sum: { sizeBytes: 0 } });
  prismaMock.document.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "d-new",
    filename: data.filename,
    sizeBytes: data.sizeBytes,
  }));
  prismaMock.document.count.mockResolvedValue(0);
  prismaMock.$transaction.mockImplementation(async (fn: (tx: typeof prismaMock) => unknown) => fn(prismaMock));
});

describe("prefixDerivedFilename", () => {
  it("marks synthetic, derived, and downloaded files", () => {
    expect(prefixDerivedFilename("a.csv", "created", true)).toBe("[synthetic] a.csv");
    expect(prefixDerivedFilename("a.csv", "created", false)).toBe("[derived] a.csv");
    expect(prefixDerivedFilename("a.csv", "fetched", false)).toBe("[downloaded] a.csv");
  });
});

describe("createDerivedDocument", () => {
  it("stores a derived document with provenance and session link", async () => {
    prismaMock.document.findFirst.mockResolvedValueOnce({ id: "d-parent", tabularData: { sheets: [] } });
    const result = await createDerivedDocument({
      ...BASE,
      filename: "ringkas.csv",
      mimeType: "text/csv",
      data: new Uint8Array([1, 2, 3]),
      origin: "created",
      parentDocumentId: "d-parent",
      sourceNote: "derived for test",
    });
    expect(result).toMatchObject({ id: "d-new", origin: "created", parentDocumentId: "d-parent" });
    expect(result.filename).toBe("[derived] ringkas.csv");
    const created = prismaMock.document.create.mock.calls[0]![0];
    expect(created.data).toMatchObject({
      origin: "created",
      parentDocumentId: "d-parent",
      sourceNote: "derived for test",
      sessionLinks: { create: { sessionId: "s1", userId: "u1" } },
    });
    expect(putObjectMock).toHaveBeenCalledOnce();
    expect(queueAddMock).toHaveBeenCalledOnce();
  });

  it("rejects a parent outside the caller scope", async () => {
    prismaMock.document.findFirst.mockResolvedValueOnce(null);
    await expect(
      createDerivedDocument({
        ...BASE,
        filename: "x.csv",
        mimeType: "text/csv",
        data: new Uint8Array([1]),
        origin: "created",
        parentDocumentId: "d-other",
      }),
    ).rejects.toThrow("Parent dataset not found");
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("refuses a duplicate name that is still queued", async () => {
    prismaMock.document.findFirst.mockResolvedValueOnce({ id: "d-old", status: "queued" });
    await expect(
      createDerivedDocument({
        ...BASE,
        filename: "ringkas.csv",
        mimeType: "text/csv",
        data: new Uint8Array([1, 2, 3]),
        origin: "created",
      }),
    ).rejects.toThrow("Do not create it again — call read_dataset");
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("refuses a session that already has the derived cap", async () => {
    prismaMock.document.count.mockResolvedValue(20);
    await expect(
      createDerivedDocument({
        ...BASE,
        filename: "more.csv",
        mimeType: "text/csv",
        data: new Uint8Array([1]),
        origin: "created",
      }),
    ).rejects.toThrow("Too many derived datasets");
    expect(prismaMock.document.create).not.toHaveBeenCalled();
  });

  it("rejects empty and oversized payloads", async () => {
    await expect(
      createDerivedDocument({ ...BASE, filename: "e.csv", mimeType: "text/csv", data: new Uint8Array([]), origin: "created" }),
    ).rejects.toThrow("File is empty");
    await expect(
      createDerivedDocument({
        ...BASE,
        filename: "big.csv",
        mimeType: "text/csv",
        data: { byteLength: 11 * 1024 * 1024 } as Uint8Array,
        origin: "created",
      }),
    ).rejects.toThrow("exceeds 10MB");
  });
});

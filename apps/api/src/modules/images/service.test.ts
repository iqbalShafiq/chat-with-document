import { describe, expect, it, vi } from "vitest";
import {
  createImageStore,
  type GeneratedImageRecord,
  type ImageStorePrisma,
} from "./service.js";

const USER_ID = "user-1";
const SESSION_ID = "session-1";
const PROJECT_ID = "project-1";

const UUID_V4_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function makeRecord(
  overrides: Partial<GeneratedImageRecord> = {},
): GeneratedImageRecord {
  return {
    id: "img-1",
    userId: USER_ID,
    projectId: null,
    sessionId: SESSION_ID,
    r2Key: `images/${USER_ID}/generated-1`,
    mediaType: "image/png",
    width: 1024,
    height: 1024,
    modelId: "model-1",
    prompt: "a cat on a sofa",
    nOfTotal: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function setup() {
  const fakePrisma = {
    generatedImage: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    chatSession: {
      findFirst: vi.fn(),
    },
  };
  const putObject = vi.fn(
    async (_key: string, _body: Uint8Array, _contentType: string) => {},
  );
  const getObjectBuffer = vi.fn(async () => new Uint8Array([9, 8, 7]));
  const store = createImageStore({
    prisma: fakePrisma as unknown as ImageStorePrisma,
    putObject,
    getObjectBuffer,
  });
  return { fakePrisma, putObject, getObjectBuffer, store };
}

describe("createImageStore", () => {
  describe("saveGeneratedImage", () => {
    it("uploads the buffer to R2 first, then persists the row with an r2Key", async () => {
      const { fakePrisma, putObject, store } = setup();
      fakePrisma.generatedImage.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: "img-1",
          ...data,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
      );
      const buffer = new Uint8Array([1, 2, 3, 4]);

      const record = await store.saveGeneratedImage({
        userId: USER_ID,
        sessionId: SESSION_ID,
        projectId: null,
        buffer,
        modelId: "model-1",
        prompt: "a cat on a sofa",
        width: 1024,
        height: 1024,
        nOfTotal: "2 of 3",
      });

      expect(putObject).toHaveBeenCalledTimes(1);
      const [key, body, contentType] = putObject.mock.calls[0] as [
        string,
        Uint8Array,
        string,
      ];
      expect(key).toMatch(new RegExp(`^images/${USER_ID}/${UUID_V4_SOURCE}$`));
      expect(Array.from(body)).toEqual([1, 2, 3, 4]);
      expect(contentType).toBe("image/png");

      expect(fakePrisma.generatedImage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: USER_ID,
          sessionId: SESSION_ID,
          projectId: null,
          r2Key: key,
          mediaType: "image/png",
          width: 1024,
          height: 1024,
          modelId: "model-1",
          prompt: "a cat on a sofa",
          nOfTotal: "2 of 3",
        }),
      });
      expect(
        putObject.mock.invocationCallOrder[0]!,
      ).toBeLessThan(
        fakePrisma.generatedImage.create.mock.invocationCallOrder[0]!,
      );
      expect(record).toMatchObject({
        id: "img-1",
        r2Key: key,
        nOfTotal: "2 of 3",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      });
    });

    it("defaults mediaType to image/png and omits nOfTotal when not provided", async () => {
      const { fakePrisma, putObject, store } = setup();
      fakePrisma.generatedImage.create.mockResolvedValue(makeRecord());

      await store.saveGeneratedImage({
        userId: USER_ID,
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        buffer: new Uint8Array([5]),
        modelId: "model-1",
        prompt: "p",
        width: 512,
        height: 512,
      });

      expect(putObject).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^images/${USER_ID}/`)),
        expect.any(Uint8Array),
        "image/png",
      );
      const data = fakePrisma.generatedImage.create.mock.calls[0]?.[0]
        .data as Record<string, unknown>;
      expect(data).toMatchObject({
        mediaType: "image/png",
        projectId: PROJECT_ID,
      });
      expect(data.nOfTotal).toBeUndefined();
    });

    it("passes a custom mediaType through to R2 and the row", async () => {
      const { fakePrisma, putObject, store } = setup();
      fakePrisma.generatedImage.create.mockResolvedValue(makeRecord());

      await store.saveGeneratedImage({
        userId: USER_ID,
        sessionId: SESSION_ID,
        projectId: null,
        buffer: new Uint8Array([6]),
        mediaType: "image/jpeg",
        modelId: "model-1",
        prompt: "p",
        width: 512,
        height: 512,
      });

      expect(putObject).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Uint8Array),
        "image/jpeg",
      );
      expect(fakePrisma.generatedImage.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ mediaType: "image/jpeg" }),
      });
    });
  });

  describe("list functions", () => {
    it("listSessionImages filters by sessionId, newest first", async () => {
      const { fakePrisma, store } = setup();
      const records = [makeRecord({ id: "img-2" }), makeRecord({ id: "img-1" })];
      fakePrisma.generatedImage.findMany.mockResolvedValue(records);

      await expect(store.listSessionImages(SESSION_ID)).resolves.toEqual(
        records,
      );
      expect(fakePrisma.generatedImage.findMany).toHaveBeenCalledWith({
        where: { sessionId: SESSION_ID },
        orderBy: { createdAt: "desc" },
      });
    });

    it("listProjectImages filters by projectId", async () => {
      const { fakePrisma, store } = setup();
      fakePrisma.generatedImage.findMany.mockResolvedValue([]);

      await expect(store.listProjectImages(PROJECT_ID)).resolves.toEqual([]);
      expect(fakePrisma.generatedImage.findMany).toHaveBeenCalledWith({
        where: { projectId: PROJECT_ID },
      });
    });

    it("listUserImages filters by userId with projectId null (standalone)", async () => {
      const { fakePrisma, store } = setup();
      fakePrisma.generatedImage.findMany.mockResolvedValue([]);

      await expect(store.listUserImages(USER_ID)).resolves.toEqual([]);
      expect(fakePrisma.generatedImage.findMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, projectId: null },
      });
    });
  });

  describe("getImage", () => {
    it("returns the row via findFirst by id", async () => {
      const { fakePrisma, store } = setup();
      const record = makeRecord();
      fakePrisma.generatedImage.findFirst.mockResolvedValue(record);

      await expect(store.getImage("img-1")).resolves.toEqual(record);
      expect(fakePrisma.generatedImage.findFirst).toHaveBeenCalledWith({
        where: { id: "img-1" },
      });
    });

    it("returns null when the row is missing", async () => {
      const { fakePrisma, store } = setup();
      fakePrisma.generatedImage.findFirst.mockResolvedValue(null);

      await expect(store.getImage("img-missing")).resolves.toBeNull();
    });
  });

  describe("assertImageAccess", () => {
    it("allows the owner of the image", async () => {
      const { fakePrisma, store } = setup();

      await expect(
        store.assertImageAccess({
          userId: USER_ID,
          image: makeRecord(),
        }),
      ).resolves.toBe(true);
      expect(fakePrisma.chatSession.findFirst).not.toHaveBeenCalled();
    });

    it("denies a non-owner when the image has no projectId", async () => {
      const { fakePrisma, store } = setup();

      await expect(
        store.assertImageAccess({
          userId: "user-2",
          image: makeRecord({ projectId: null }),
        }),
      ).resolves.toBe(false);
      expect(fakePrisma.chatSession.findFirst).not.toHaveBeenCalled();
    });

    it("allows a project member who is not the owner", async () => {
      const { fakePrisma, store } = setup();
      fakePrisma.chatSession.findFirst.mockResolvedValue({ id: SESSION_ID });

      await expect(
        store.assertImageAccess({
          userId: "user-2",
          image: makeRecord({ projectId: PROJECT_ID }),
        }),
      ).resolves.toBe(true);
      expect(fakePrisma.chatSession.findFirst).toHaveBeenCalledWith({
        where: { projectId: PROJECT_ID, userId: "user-2" },
        select: { id: true },
      });
    });

    it("denies a non-member of the project", async () => {
      const { fakePrisma, store } = setup();
      fakePrisma.chatSession.findFirst.mockResolvedValue(null);

      await expect(
        store.assertImageAccess({
          userId: "user-3",
          image: makeRecord({ projectId: PROJECT_ID }),
        }),
      ).resolves.toBe(false);
      expect(fakePrisma.chatSession.findFirst).toHaveBeenCalledWith({
        where: { projectId: PROJECT_ID, userId: "user-3" },
        select: { id: true },
      });
    });
  });
});

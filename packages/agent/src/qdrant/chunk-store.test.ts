import type { EmbeddingModel, EmbeddedDocument } from "@anvia/core/embeddings";
import type { QdrantClientLike } from "@anvia/qdrant";
import { describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_DIMENSIONS,
  QDRANT_COLLECTION,
  type DocumentChunkMetadata,
} from "../document/types.js";

vi.mock("../providers/mistral.js", () => ({
  createEmbeddingModel: vi.fn(() => ({
    provider: "test",
    modelId: "process-test-embedding",
    dimensions: 1024,
    embedTexts: vi.fn(async () => []),
  })),
}));

import * as chunkStoreModule from "./chunk-store.js";

type ChunkStoreLifecycle = {
  upsertDocumentChunks(
    documents: Array<EmbeddedDocument<string, DocumentChunkMetadata>>,
  ): Promise<void>;
  deleteDocumentChunks(documentId: string): Promise<void>;
  createChunkSearchService(): ReturnType<
    typeof chunkStoreModule.createChunkSearchService
  >;
  close(): Promise<void>;
};

type ChunkStoreModule = typeof chunkStoreModule & {
  createQdrantChunkStore?: (options: {
    client: QdrantClientLike;
    model: EmbeddingModel;
  }) => ChunkStoreLifecycle;
};

const createQdrantChunkStore = (
  chunkStoreModule as ChunkStoreModule
).createQdrantChunkStore;

function denseVector(seed = 0): number[] {
  const vector = Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = seed;
  return vector;
}

function chunkDocument(
  overrides: Partial<EmbeddedDocument<string, DocumentChunkMetadata>> = {},
): EmbeddedDocument<string, DocumentChunkMetadata> {
  return {
    id: "chunk-1",
    document: "Chunk one",
    embeddings: [{ document: "Chunk one", vector: denseVector(1) }],
    metadata: {
      userId: "user-1",
      sessionId: "session-origin",
      documentId: "document-1",
      filename: "guide.pdf",
      pageId: "page-1",
      pageIndex: 0,
      chunkIndex: 0,
      chunkText: "Chunk one",
      documentPageCount: 2,
    },
    ...overrides,
  };
}

function createEmbeddingModel() {
  const embedTexts = vi.fn(async (texts: string[]) =>
    texts.map((document) => ({ document, vector: denseVector(9) })),
  );
  const model: EmbeddingModel = {
    provider: "test",
    modelId: "test-embedding",
    dimensions: EMBEDDING_DIMENSIONS,
    embedTexts,
  };
  return { embedTexts, model };
}

type FakeQdrantClient = QdrantClientLike & {
  collectionExists: ReturnType<typeof vi.fn>;
  createCollection: ReturnType<typeof vi.fn>;
  getCollection: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
};

function createNativeClient(
  overrides: Partial<QdrantClientLike> = {},
): FakeQdrantClient {
  let exists = false;
  const collectionExists = vi.fn(async () => ({ exists }));
  const createCollection = vi.fn(async () => {
    exists = true;
    return {};
  });
  const getCollection = vi.fn(async () => ({
    config: {
      params: {
        vectors: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
      },
    },
  }));
  const deletePoints = vi.fn(async () => ({}));
  const upsert = vi.fn(async () => ({}));
  const query = vi.fn(async () => ({ result: { points: [] } }));

  return {
    collectionExists,
    createCollection,
    getCollection,
    delete: deletePoints,
    upsert,
    query,
    ...overrides,
  } as FakeQdrantClient;
}

function createLifecycle(
  client: QdrantClientLike,
  model: EmbeddingModel,
): ChunkStoreLifecycle {
  expect(createQdrantChunkStore).toBeTypeOf("function");
  if (!createQdrantChunkStore) {
    throw new Error("createQdrantChunkStore is not implemented");
  }
  return createQdrantChunkStore({ client, model });
}

function qdrantPoint(input: {
  id: string;
  score: number;
  documentId: string;
  filename: string;
  pageId: string;
  pageIndex: number;
  chunkIndex: number;
  chunkText: string;
  documentPageCount: number;
}) {
  return {
    id: `native-${input.id}-${input.score}`,
    score: input.score,
    payload: {
      __anvia_document_id: input.id,
      __anvia_document: input.chunkText,
      userId: "user-1",
      sessionId: "session-origin",
      documentId: input.documentId,
      filename: input.filename,
      pageId: input.pageId,
      pageIndex: input.pageIndex,
      chunkIndex: input.chunkIndex,
      chunkText: input.chunkText,
      documentPageCount: input.documentPageCount,
    },
  };
}

describe("Qdrant chunk store v1 lifecycle", () => {
  it("ensures once on first use and replacement-upserts logical chunk ids", async () => {
    const client = createNativeClient();
    const { model } = createEmbeddingModel();
    const lifecycle = createLifecycle(client, model);
    const document = chunkDocument();

    await lifecycle.upsertDocumentChunks([document]);
    await lifecycle.upsertDocumentChunks([document]);

    expect(client.collectionExists).toHaveBeenCalledOnce();
    expect(client.createCollection).toHaveBeenCalledOnce();
    expect(client.createCollection).toHaveBeenCalledWith(QDRANT_COLLECTION, {
      vectors: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
    });
    expect(client.getCollection).toHaveBeenCalledOnce();
    expect(client.delete).toHaveBeenCalledTimes(2);
    expect(client.delete).toHaveBeenNthCalledWith(1, QDRANT_COLLECTION, {
      wait: true,
      filter: {
        must: [
          {
            key: "__anvia_document_id",
            match: { any: ["chunk-1"] },
          },
        ],
      },
    });
    expect(client.upsert).toHaveBeenCalledTimes(2);
    expect(client.upsert).toHaveBeenNthCalledWith(1, QDRANT_COLLECTION, {
      wait: true,
      points: [
        expect.objectContaining({
          vector: denseVector(1),
          payload: expect.objectContaining({
            __anvia_document_id: "chunk-1",
            __anvia_document: "Chunk one",
            documentId: "document-1",
            chunkText: "Chunk one",
          }),
        }),
      ],
    });
  });

  it("keeps the native metadata deletion boundary and ignores a missing collection", async () => {
    const missing = Object.assign(new Error("collection not found"), {
      status: 404,
    });
    const deletePoints = vi.fn(async () => {
      throw missing;
    });
    const client = createNativeClient({ delete: deletePoints });
    const { model } = createEmbeddingModel();
    const lifecycle = createLifecycle(client, model);

    await expect(
      lifecycle.deleteDocumentChunks("document-1"),
    ).resolves.toBeUndefined();

    expect(deletePoints).toHaveBeenCalledOnce();
    expect(deletePoints).toHaveBeenCalledWith(QDRANT_COLLECTION, {
      wait: true,
      filter: {
        must: [
          { key: "documentId", match: { value: "document-1" } },
        ],
      },
    });
  });

  it("applies ownership/document filters and returns logical topK in score order", async () => {
    const duplicateLow = qdrantPoint({
      id: "chunk-a",
      score: 0.4,
      documentId: "document-1",
      filename: "guide.pdf",
      pageId: "page-1",
      pageIndex: 0,
      chunkIndex: 0,
      chunkText: "Lower duplicate",
      documentPageCount: 2,
    });
    const duplicateHigh = qdrantPoint({
      id: "chunk-a",
      score: 0.95,
      documentId: "document-1",
      filename: "guide.pdf",
      pageId: "page-1",
      pageIndex: 0,
      chunkIndex: 0,
      chunkText: "Best match",
      documentPageCount: 2,
    });
    const second = qdrantPoint({
      id: "chunk-b",
      score: 0.7,
      documentId: "document-2",
      filename: "manual.pdf",
      pageId: "page-9",
      pageIndex: 1,
      chunkIndex: 3,
      chunkText: "Second match",
      documentPageCount: 2,
    });
    const extra = qdrantPoint({
      id: "chunk-c",
      score: 0.2,
      documentId: "document-2",
      filename: "manual.pdf",
      pageId: "page-10",
      pageIndex: 0,
      chunkIndex: 4,
      chunkText: "Extra match",
      documentPageCount: 1,
    });
    const query = vi.fn(async (_collection: string, options: unknown) => {
      const limit = (options as { limit: number }).limit;
      return {
        result: {
          points:
            limit === 2
              ? [duplicateLow, duplicateHigh]
              : [duplicateLow, duplicateHigh, second, extra],
        },
      };
    });
    const client = createNativeClient({ query });
    const { embedTexts, model } = createEmbeddingModel();
    const lifecycle = createLifecycle(client, model);

    const results = await lifecycle.createChunkSearchService().search({
      userId: "user-1",
      sessionId: "session-current",
      query: "best sections",
      documentIds: ["document-1", "document-2"],
      limit: 2,
    });

    expect(embedTexts).toHaveBeenCalledOnce();
    expect(embedTexts.mock.calls[0]?.[0]).toEqual(["best sections"]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(
      query.mock.calls.map(
        ([, options]) => (options as { limit: number }).limit,
      ),
    ).toEqual([2, 4]);
    expect(query).toHaveBeenNthCalledWith(
      1,
      QDRANT_COLLECTION,
      expect.objectContaining({
        limit: 2,
        filter: {
          must: [
            {
              must: [
                { key: "userId", match: { value: "user-1" } },
              ],
            },
            {
              should: [
                {
                  must: [
                    {
                      key: "documentId",
                      match: { value: "document-1" },
                    },
                  ],
                },
                {
                  must: [
                    {
                      key: "documentId",
                      match: { value: "document-2" },
                    },
                  ],
                },
              ],
            },
          ],
        },
        with_payload: true,
      }),
    );
    expect(results).toEqual([
      {
        chunkId: "chunk-a",
        documentId: "document-1",
        filename: "guide.pdf",
        pageId: "page-1",
        pageIndex: 0,
        chunkIndex: 0,
        chunkText: "Best match",
        score: 0.95,
        hasNextPage: true,
      },
      {
        chunkId: "chunk-b",
        documentId: "document-2",
        filename: "manual.pdf",
        pageId: "page-9",
        pageIndex: 1,
        chunkIndex: 3,
        chunkText: "Second match",
        score: 0.7,
        hasNextPage: false,
      },
    ]);
  });

  it("does not initialize Qdrant for an empty document scope", async () => {
    const client = createNativeClient();
    const { embedTexts, model } = createEmbeddingModel();
    const lifecycle = createLifecycle(client, model);

    await expect(
      lifecycle.createChunkSearchService().search({
        userId: "user-1",
        query: "anything",
        documentIds: [],
        limit: 5,
      }),
    ).resolves.toEqual([]);

    expect(client.collectionExists).not.toHaveBeenCalled();
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it("returns one close promise and rejects use after close", async () => {
    const client = createNativeClient();
    const { model } = createEmbeddingModel();
    const lifecycle = createLifecycle(client, model);

    const first = lifecycle.close();
    const second = lifecycle.close();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    await expect(
      lifecycle.upsertDocumentChunks([chunkDocument()]),
    ).rejects.toThrow("QdrantVectorClient is closed");
  });
});

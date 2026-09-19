import type {
  EmbeddingModel,
  EmbeddedDocument,
} from "@anvia/core/embeddings";
import {
  retrieveDocuments,
  vectorFilter,
} from "@anvia/core/vector-store";
import {
  QdrantVectorClient,
  type QdrantClientLike,
  type QdrantVectorStore,
} from "@anvia/qdrant";
import {
  EMBEDDING_DIMENSIONS,
  QDRANT_COLLECTION,
  type DocumentChunkMetadata,
} from "../document/types.js";
import { createEmbeddingModel } from "../providers/mistral.js";
import type { ChunkSearchHit, ChunkSearchService } from "../tools/documents.js";

export type QdrantChunkStoreOptions = {
  /** Native delegate injection keeps the adapter testable without Qdrant I/O. */
  client?: QdrantClientLike;
  model?: EmbeddingModel;
  url?: string;
};

export type ChunkIOOptions = {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
};

export type QdrantChunkStoreLifecycle = {
  upsertDocumentChunks(
    documents: Array<EmbeddedDocument<string, DocumentChunkMetadata>>,
    options?: ChunkIOOptions,
  ): Promise<void>;
  deleteDocumentChunks(documentId: string, options?: ChunkIOOptions): Promise<void>;
  createChunkSearchService(): ChunkSearchService;
  close(): Promise<void>;
};

function getQdrantUrl() {
  return process.env.QDRANT_URL ?? "http://localhost:16333";
}

function isMissingCollectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  if (
    candidate.status === 404 ||
    candidate.statusCode === 404 ||
    candidate.response?.status === 404
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:\b404\b|not\s*found|missing\s+collection)/i.test(message);
}

/**
 * Own one Anvia v1 Qdrant client and its dense store for the process lifetime.
 * Construction is I/O-free; the collection is ensured once on first use.
 */
export function createQdrantChunkStore(
  options: QdrantChunkStoreOptions = {},
): QdrantChunkStoreLifecycle {
  const vectorClient = new QdrantVectorClient(
    options.client === undefined
      ? { url: options.url ?? getQdrantUrl() }
      : { client: options.client },
  );
  const store: QdrantVectorStore<string, DocumentChunkMetadata> =
    vectorClient.vectorStore<string, DocumentChunkMetadata>({
      collectionName: QDRANT_COLLECTION,
      dimensions: EMBEDDING_DIMENSIONS,
      metric: "cosine",
    });
  const model = options.model ?? createEmbeddingModel();
  let ensurePromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;

  async function getStore(): Promise<
    QdrantVectorStore<string, DocumentChunkMetadata>
  > {
    if (!ensurePromise) {
      ensurePromise = store.ensure().catch((error: unknown) => {
        ensurePromise = null;
        throw error;
      });
    }
    await ensurePromise;
    return store;
  }

  async function upsertDocumentChunks(
    documents: Array<EmbeddedDocument<string, DocumentChunkMetadata>>,
    options: ChunkIOOptions = {},
  ): Promise<void> {
    options.abortSignal?.throwIfAborted();
    const readyStore = await ioWithBudget(options, () => getStore());
    options.abortSignal?.throwIfAborted();
    await ioWithBudget(options, () => readyStore.upsert({ documents }));
  }

  async function deleteDocumentChunks(documentId: string, options: ChunkIOOptions = {}): Promise<void> {
    options.abortSignal?.throwIfAborted();
    await ioWithBudget(options, () => getStore());
    const nativeClient = await ioWithBudget(options, () => vectorClient.nativeClient());
    if (!nativeClient.delete) {
      throw new TypeError("Qdrant metadata deletion requires delete(...).");
    }

    try {
      // The public v1 store deletes Anvia logical ids. Re-ingest must instead
      // purge every chunk whose application metadata belongs to this document.
      const client: { delete: NonNullable<typeof nativeClient.delete> } = {
        delete: nativeClient.delete.bind(nativeClient),
      };
      await ioWithBudget(options, () =>
        client.delete(QDRANT_COLLECTION, {
          wait: true,
          filter: {
            must: [{ key: "documentId", match: { value: documentId } }],
          },
        }),
      );
    } catch (error) {
      // A concurrently wiped collection is equivalent to an empty chunk set.
      if (isMissingCollectionError(error)) return;
      throw error;
    }
  }

  function createChunkSearchService(): ChunkSearchService {
    return {
      async search({ userId, query, documentIds, limit }) {
        if (!documentIds || documentIds.length === 0) {
          return [];
        }

        const readyStore = await getStore();
        const results = await retrieveDocuments({
          store: readyStore,
          model,
          query,
          topK: limit,
          filter: buildUserDocumentsFilter(userId, documentIds),
        });

        return results.map((result) => {
          const metadata = result.metadata!;
          return {
            chunkId: result.id,
            documentId: metadata.documentId,
            filename: metadata.filename,
            pageId: metadata.pageId,
            pageIndex: metadata.pageIndex,
            chunkIndex: metadata.chunkIndex,
            chunkText: metadata.chunkText,
            score: result.score,
            hasNextPage:
              metadata.pageIndex + 1 < (metadata.documentPageCount ?? 0),
          } satisfies ChunkSearchHit;
        });
      },
    };
  }

  function close(): Promise<void> {
    closePromise ??= vectorClient.close();
    return closePromise;
  }

  return {
    upsertDocumentChunks,
    deleteDocumentChunks,
    createChunkSearchService,
    close,
  };
}

/**
 * Retrieve by user ownership + explicit document ids.
 * Session membership is enforced in tools before calling search so docs
 * re-linked across chats remain searchable regardless of origin sessionId
 * stored on the vectors.
 */
function buildUserDocumentsFilter(userId: string, documentIds: string[]) {
  const ownership = vectorFilter.eq("userId", userId);

  if (documentIds.length === 0) {
    // Empty set must not match all user vectors.
    return vectorFilter.and(
      ownership,
      vectorFilter.eq("documentId", "__none__"),
    );
  }

  const docFilters = documentIds.map((documentId) =>
    vectorFilter.eq("documentId", documentId),
  );

  if (docFilters.length === 1) {
    return vectorFilter.and(ownership, docFilters[0]!);
  }

  let docOr = docFilters[0]!;
  for (let i = 1; i < docFilters.length; i += 1) {
    docOr = vectorFilter.or(docOr, docFilters[i]!);
  }

  return vectorFilter.and(ownership, docOr);
}

let processChunkStore: QdrantChunkStoreLifecycle | null = null;

function getProcessChunkStore(): QdrantChunkStoreLifecycle {
  // Both Qdrant and Mistral are live process dependencies. Keep their
  // construction behind the first ingest/search call so importing the agent
  // package remains credential-free and testable.
  processChunkStore ??= createQdrantChunkStore();
  return processChunkStore;
}

async function ioWithBudget<T>(options: ChunkIOOptions, work: () => Promise<T>): Promise<T> {
  const timeoutMs = options.timeoutMs;
  if (timeoutMs === undefined) return work();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Vector store exceeded its ${timeoutMs}ms budget.`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function upsertDocumentChunks(
  documents: Array<EmbeddedDocument<string, DocumentChunkMetadata>>,
  options?: ChunkIOOptions,
): Promise<void> {
  return getProcessChunkStore().upsertDocumentChunks(documents, options);
}

export function deleteDocumentChunks(
  documentId: string,
  options?: ChunkIOOptions,
): Promise<void> {
  return getProcessChunkStore().deleteDocumentChunks(documentId, options);
}

export function createChunkSearchService(): ChunkSearchService {
  return getProcessChunkStore().createChunkSearchService();
}

export function closeQdrant(): Promise<void> {
  return getProcessChunkStore().close();
}

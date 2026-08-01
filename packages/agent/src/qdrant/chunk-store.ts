import { vectorFilter } from "@anvia/core/vector-store";
import type { EmbeddedDocument } from "@anvia/core/embeddings";
import { QdrantClient } from "@qdrant/js-client-rest";
import { QdrantVectorStore } from "@anvia/qdrant";
import {
  EMBEDDING_DIMENSIONS,
  QDRANT_COLLECTION,
  type DocumentChunkMetadata,
} from "../document/types.js";
import { embeddingModel } from "../providers/mistral.js";
import type { ChunkSearchHit, ChunkSearchService } from "../tools/documents.js";

let storePromise: Promise<QdrantVectorStore<string, DocumentChunkMetadata>> | null =
  null;

function getQdrantUrl() {
  return process.env.QDRANT_URL ?? "http://localhost:16333";
}

async function getStore() {
  if (!storePromise) {
    storePromise = QdrantVectorStore.connect<string, DocumentChunkMetadata>({
      client: new QdrantClient({ url: getQdrantUrl() }),
      collectionName: QDRANT_COLLECTION,
      vectorSize: EMBEDDING_DIMENSIONS,
      createIfMissing: true,
      distance: "Cosine",
    });
  }
  return storePromise;
}

export async function upsertDocumentChunks(
  documents: Array<EmbeddedDocument<string, DocumentChunkMetadata>>,
) {
  const store = await getStore();
  await store.upsertDocuments(documents);
}

function isMissingCollectionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "status" in error ? error.status : undefined;
  if (status === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not\s*found/i.test(message);
}

export async function deleteDocumentChunks(documentId: string) {
  const client = new QdrantClient({ url: getQdrantUrl() });

  try {
    const { collections } = await client.getCollections();
    const exists = collections.some(
      (collection) => collection.name === QDRANT_COLLECTION,
    );
    if (!exists) return;

    await client.delete(QDRANT_COLLECTION, {
      wait: true,
      filter: {
        must: [{ key: "documentId", match: { value: documentId } }],
      },
    });
  } catch (error) {
    // First ingest (or wiped Qdrant) has no collection yet — treat as empty.
    if (isMissingCollectionError(error)) return;
    throw error;
  }
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

export function createChunkSearchService(): ChunkSearchService {
  return {
    async search({ userId, query, documentIds, limit }) {
      if (!documentIds || documentIds.length === 0) {
        return [];
      }

      const store = await getStore();
      const index = store.index(embeddingModel);
      const results = await index.search({
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

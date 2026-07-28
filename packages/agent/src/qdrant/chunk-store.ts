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

export async function deleteDocumentChunks(documentId: string) {
  const client = new QdrantClient({ url: getQdrantUrl() });
  await client.delete(QDRANT_COLLECTION, {
    wait: true,
    filter: {
      must: [{ key: "documentId", match: { value: documentId } }],
    },
  });
}

function buildSessionFilter(sessionId: string, documentIds?: string[]) {
  const sessionFilter = vectorFilter.eq("sessionId", sessionId);
  if (!documentIds || documentIds.length === 0) {
    return sessionFilter;
  }

  const docFilters = documentIds.map((documentId) =>
    vectorFilter.eq("documentId", documentId),
  );

  if (docFilters.length === 1) {
    return vectorFilter.and(sessionFilter, docFilters[0]!);
  }

  let docOr = docFilters[0]!;
  for (let i = 1; i < docFilters.length; i += 1) {
    docOr = vectorFilter.or(docOr, docFilters[i]!);
  }

  return vectorFilter.and(sessionFilter, docOr);
}

export function createChunkSearchService(): ChunkSearchService {
  return {
    async search({ sessionId, query, documentIds, limit }) {
      const store = await getStore();
      const index = store.index(embeddingModel);
      const results = await index.search({
        query,
        topK: limit,
        filter: buildSessionFilter(sessionId, documentIds),
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

export async function enrichChunkHitsWithNextPage(
  hits: ChunkSearchHit[],
): Promise<ChunkSearchHit[]> {
  return hits;
}

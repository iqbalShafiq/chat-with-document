import type { TavilyClient } from "@tavily/core";
import {
  AssistantContent,
  type CompletionModel,
  type JsonObject,
  Usage,
} from "@anvia/core/completion";
import type { ImageGenerationModel } from "@anvia/core/image-generation";
import type { ClarificationRequest } from "../tools/clarification.js";
import type { ClarificationResponse } from "../tools/clarification.js";
import type {
  ChunkSearchService,
  FindDocumentsPrisma,
  NextPagePrisma,
  PageImagesPrisma,
  SessionDocumentIdsPrisma,
} from "../tools/documents.js";
import { TRANSPARENT_1X1_PNG_BASE64 } from "../e2e/image-e2e-helpers.js";
import {
  FIXTURE_CLARIFICATION_ANSWERS,
  FIXTURE_DOCUMENTS,
  stubSearchResults,
} from "./fixtures.js";

export type ScriptedStep =
  | { kind: "tool_call"; name: string; args?: Record<string, unknown> }
  | { kind: "text"; text: string };

export type FakePrisma = FindDocumentsPrisma &
  NextPagePrisma &
  SessionDocumentIdsPrisma &
  PageImagesPrisma;

export function createStubTavilyClient(): TavilyClient {
  return {
    search: async (query: string) => ({
      query,
      answer: `Fixture web answer for: ${query}`,
      results: stubSearchResults(query).results,
      responseTime: 1,
      images: [],
      requestId: "fixture",
    }),
    extract: async (urls: string[]) => ({
      results: urls.map((url) => ({
        url,
        title: `Fixture page ${url}`,
        rawContent: `Fixture extracted content for ${url}`,
        content: `Fixture extracted content for ${url}`,
      })),
      failedResults: [],
      responseTime: 1,
    }),
  } as unknown as TavilyClient;
}

export function createStubImageModel(): ImageGenerationModel<unknown, string> {
  return {
    provider: "fixture",
    defaultModel: "fixture/image",
    imageGeneration: async () => {
      const data = Uint8Array.from(
        Buffer.from(TRANSPARENT_1X1_PNG_BASE64, "base64"),
      );
      return {
        image: data,
        images: [{ data, mediaType: "image/png" }],
        mediaType: "image/png",
        rawResponse: {},
      };
    },
  };
}

export function createFakePrisma(): FakePrisma {
  return {
    document: {
      findMany: async (args) => {
        const query =
          args.where.OR.map(
            (condition) =>
              condition.filename?.contains ??
              condition.summary?.contains ??
              condition.firstPageSummary?.contains,
          ).find((value) => value !== undefined) ?? "";
        const needle = query.toLowerCase();
        const allowed =
          args.where.id?.in ?? FIXTURE_DOCUMENTS.map((doc) => doc.id);
        return FIXTURE_DOCUMENTS.filter(
          (doc) =>
            allowed.includes(doc.id) &&
            (needle === "" ||
              doc.filename.toLowerCase().includes(needle) ||
              doc.summary.toLowerCase().includes(needle) ||
              doc.firstPageSummary.toLowerCase().includes(needle)),
        )
          .slice(0, args.take)
          .map((doc) => ({
            id: doc.id,
            filename: doc.filename,
            firstPageSummary: doc.firstPageSummary,
            summary: doc.summary,
            pageCount: doc.pageCount,
          }));
      },
      findFirst: async (args) => {
        const doc = FIXTURE_DOCUMENTS.find((d) => d.id === args.where.id);
        if (!doc) return null;
        return { id: doc.id, pageCount: doc.pageCount, filename: doc.filename };
      },
    },
    documentPage: {
      findFirst: async (args) => {
        const doc = FIXTURE_DOCUMENTS.find(
          (d) => d.id === args.where.documentId,
        );
        const page = doc?.pages.find(
          (p) => p.pageIndex === args.where.pageIndex,
        );
        if (!page) return null;
        return {
          id: page.id,
          pageIndex: page.pageIndex,
          summary: page.summary,
          rawMarkdown: page.rawMarkdown,
          images: page.images ?? null,
        };
      },
    },
    documentSession: {
      findMany: async () =>
        FIXTURE_DOCUMENTS.map((doc) => ({ documentId: doc.id })),
    },
  };
}

export function createStubChunkSearchService(): ChunkSearchService {
  return {
    search: async ({ query, documentIds, limit }) => {
      const hits = FIXTURE_DOCUMENTS.flatMap((doc) => {
        if (!documentIds.includes(doc.id)) return [];
        return doc.chunks
          .filter((c) =>
            c.chunkText.toLowerCase().includes(query.toLowerCase()),
          )
          .map((c) => ({
            chunkId: c.chunkId,
            documentId: c.documentId,
            filename: c.filename,
            pageId: c.pageId,
            pageIndex: c.pageIndex,
            chunkIndex: c.chunkIndex,
            chunkText: c.chunkText,
            score: 1,
            hasNextPage: c.hasNextPage,
          }));
      });
      return hits.slice(0, limit);
    },
  };
}

export function createAutoClarificationResponder(
  answers: Record<string, string> = FIXTURE_CLARIFICATION_ANSWERS,
) {
  return async (
    request: ClarificationRequest,
  ): Promise<ClarificationResponse> => ({
    answers: Object.fromEntries(
      request.questions.map((q) => [q.id, answers[q.id] ?? "default"]),
    ),
    skipped: [],
    timedOut: false,
  });
}

export function createStubViewImageModel(): CompletionModel {
  return {
    provider: "fixture",
    defaultModel: "fixture-vision",
    capabilities: {
      streaming: false,
      tools: false,
      toolChoice: false,
      imageInput: true,
      documentInput: false,
      outputSchema: false,
      reasoning: false,
    },
    async completion() {
      return {
        choice: [AssistantContent.text("A fixture description of the image.")],
        usage: Usage.empty(),
        rawResponse: {},
      };
    },
  };
}

export function createScriptedCompletionModel(
  steps: ScriptedStep[],
): CompletionModel {
  let index = 0;
  return {
    provider: "scripted",
    defaultModel: "scripted",
    capabilities: {
      streaming: false,
      tools: true,
      toolChoice: false,
      imageInput: false,
      documentInput: false,
      outputSchema: false,
      reasoning: false,
    },
    async completion() {
      const step = steps[Math.min(index, steps.length - 1)]!;
      index += 1;
      if (step.kind === "tool_call") {
        return {
          choice: [
            AssistantContent.toolCall(
              `scripted-${index}`,
              step.name,
              (step.args ?? {}) as JsonObject,
            ),
          ],
          usage: Usage.empty(),
          rawResponse: {},
        };
      }
      return {
        choice: [AssistantContent.text(step.text)],
        usage: Usage.empty(),
        rawResponse: {},
      };
    },
  };
}

import type { AnyTool } from "@anvia/core";
import { createFindDocumentsTool, type FindDocumentsPrisma } from "./document-find.js";
import { createGetDocumentNextPageTool, type NextPagePrisma } from "./document-next-page.js";
import {
  createSearchDocumentPagesTool,
  type ChunkSearchService,
} from "./document-search.js";

export interface DocumentToolsDeps {
  sessionId: string;
  prisma: FindDocumentsPrisma & NextPagePrisma;
  searchService: ChunkSearchService;
}

export function createDocumentTools(deps: DocumentToolsDeps): AnyTool[] {
  return [
    createFindDocumentsTool(deps),
    createSearchDocumentPagesTool(deps),
    createGetDocumentNextPageTool(deps),
  ];
}

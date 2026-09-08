import type { DerivedDocumentWriter } from "@anreal/agent";
import {
  MAX_DERIVED_PER_SESSION,
  type DerivedDocumentOrigin,
} from "@anreal/agent";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { createDerivedDocument } from "../documents/service.js";

export type DerivedDatasetWriterDeps = {
  userId: string;
  sessionId: string;
  projectId?: string | null;
  prisma: PrismaClient;
};

export function createDerivedDatasetWriter(deps: DerivedDatasetWriterDeps): DerivedDocumentWriter {
  return {
    async createDerived(input) {
      const derivedCount = await deps.prisma.document.count({
        where: {
          userId: deps.userId,
          sessionId: deps.sessionId,
          origin: { in: ["created", "fetched"] },
        },
      });
      if (derivedCount >= MAX_DERIVED_PER_SESSION) {
        throw new Error(
          `Too many derived datasets in this session (max ${MAX_DERIVED_PER_SESSION}). Delete an old [derived]/[downloaded] document or reuse an existing one.`,
        );
      }
      const created = await createDerivedDocument({
        userId: deps.userId,
        sessionId: deps.sessionId,
        projectId: deps.projectId ?? null,
        filename: input.filename,
        mimeType: input.mimeType,
        data: input.data,
        origin: input.origin as DerivedDocumentOrigin,
        parentDocumentId: input.parentDocumentId ?? null,
        originUrl: input.originUrl ?? null,
        sourceNote: input.sourceNote ?? null,
        synthetic: input.synthetic,
      });
      return {
        documentId: created.id,
        filename: created.filename,
        origin: created.origin as "created" | "fetched",
        status: created.status,
      };
    },
    async countDerived() {
      return deps.prisma.document.count({
        where: {
          userId: deps.userId,
          sessionId: deps.sessionId,
          origin: { in: ["created", "fetched"] },
        },
      });
    },
  };
}

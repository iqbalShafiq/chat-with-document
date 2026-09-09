import type { DerivedDocumentWriter } from "@anreal/agent";
import {
  MAX_DERIVED_PER_SESSION,
  type DerivedDocumentOrigin,
} from "@anreal/agent";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { createDerivedDocument } from "../documents/service.js";

const READY_POLL_INTERVAL_MS = 1_000;
const READY_POLL_ATTEMPTS = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(
  prisma: PrismaClient,
  documentId: string,
  attempts = READY_POLL_ATTEMPTS,
  intervalMs = READY_POLL_INTERVAL_MS,
): Promise<string> {
  let status = "queued";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const doc = await prisma.document.findUnique({
      where: { id: documentId },
      select: { status: true, errorMessage: true },
    });
    if (!doc) throw new Error("Derived document disappeared during ingest.");
    status = doc.status;
    if (status === "ready") return status;
    if (status === "failed") {
      throw new Error(`Derived document ingest failed${doc.errorMessage ? `: ${doc.errorMessage}` : "."} Fix the input and create it again.`);
    }
    await sleep(intervalMs);
  }
  return status;
}

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
      const status = await waitForReady(deps.prisma, created.id);
      return {
        documentId: created.id,
        filename: created.filename,
        origin: created.origin as "created" | "fetched",
        status,
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

import type { DerivedDocumentWriter } from "@anreal/agent";
import {
  DATASET_WAIT_ATTEMPTS,
  DATASET_WAIT_INTERVAL_MS,
  type DerivedDocumentOrigin,
} from "@anreal/agent";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { createDerivedDocument } from "../documents/service.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(
  prisma: PrismaClient,
  documentId: string,
  attempts: number,
  intervalMs: number,
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
  throw new Error(
    `Dataset is still ${status} after waiting (documentId ${documentId}). Do NOT create it again — call read_dataset later with the same documentId.`,
  );
}

export type DerivedDatasetWriterDeps = {
  userId: string;
  sessionId: string;
  projectId?: string | null;
  prisma: PrismaClient;
  wait?: { attempts?: number; intervalMs?: number };
};

export function createDerivedDatasetWriter(deps: DerivedDatasetWriterDeps): DerivedDocumentWriter {
  const attempts = deps.wait?.attempts ?? DATASET_WAIT_ATTEMPTS;
  const intervalMs = deps.wait?.intervalMs ?? DATASET_WAIT_INTERVAL_MS;
  return {
    async createDerived(input) {
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
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      });
      const status = await waitForReady(deps.prisma, created.id, attempts, intervalMs);
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

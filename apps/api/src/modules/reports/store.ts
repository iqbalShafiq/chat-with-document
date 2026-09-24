import { randomUUID } from "node:crypto";
import { prisma } from "../../utils/prisma.js";
import { buildDocumentR2Key, putObject } from "../../lib/r2.js";
import { artifactWhere } from "../artifacts/scope.js";
import { buildReportPdf, type ReportCitation } from "./service.js";

export async function createReport(input: {
  userId: string;
  sessionId: string;
  title: string;
  markdown: string;
  svgAssets?: string[];
  citationMap?: ReportCitation[];
}): Promise<{ documentId: string; filename: string }> {
  const session = await prisma.chatSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: { id: true, projectId: true },
  });
  if (!session) throw new Error("Session not found");
  const scope = artifactWhere(input.userId, session.projectId ?? null);
  const pdf = await buildReportPdf({
    title: input.title,
    markdown: input.markdown,
    svgAssets: input.svgAssets,
    citationMap: input.citationMap,
  });
  const safeTitle = input.title.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "report";
  const filename = `${safeTitle}.pdf`;
  const documentId = randomUUID();
  const r2Key = buildDocumentR2Key(input.userId, input.sessionId, documentId, filename);
  await putObject(r2Key, Buffer.from(pdf), "application/pdf");
  const doc = await prisma.document.create({
    data: {
      id: documentId,
      userId: scope.userId,
      sessionId: input.sessionId,
      projectId: scope.projectId,
      filename,
      mimeType: "application/pdf",
      sizeBytes: pdf.byteLength,
      r2Key,
      pageCount: 1,
      status: "ready",
      summary: input.title.slice(0, 500),
      firstPageSummary: input.title.slice(0, 500),
      origin: "created",
      kind: "report",
      ...(input.citationMap ? { citationMap: input.citationMap } : {}),
    },
    select: { id: true, filename: true },
  });
  await prisma.documentSession.create({
    data: { documentId: doc.id, sessionId: input.sessionId, userId: input.userId },
  });
  return { documentId: doc.id, filename: doc.filename };
}

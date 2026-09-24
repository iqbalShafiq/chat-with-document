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

/**
 * Revise a report in place: same documentId, re-rendered bytes.
 * Cross-scope ids yield not-found (never reveal other scopes).
 */
export async function editReport(input: {
  userId: string;
  sessionId: string;
  documentId: string;
  title?: string;
  markdown?: string;
  svgAssets?: string[];
  citationMap?: ReportCitation[];
}): Promise<{ documentId: string; filename: string }> {
  const session = await prisma.chatSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: { id: true, projectId: true },
  });
  if (!session) throw new Error("Session not found");
  const scope = artifactWhere(input.userId, session.projectId ?? null);
  const existing = await prisma.document.findFirst({
    where: { ...scope, id: input.documentId, kind: "report" },
  });
  if (!existing) throw new Error("Report not found");
  const title = input.title?.trim() || existing.filename.replace(/\.pdf$/, "");
  const markdown = input.markdown ?? "";
  const pdf = await buildReportPdf({
    title,
    markdown,
    svgAssets: input.svgAssets,
    citationMap: input.citationMap,
  });
  await putObject(existing.r2Key, Buffer.from(pdf), "application/pdf");
  const doc = await prisma.document.update({
    where: { id: existing.id },
    data: {
      sizeBytes: pdf.byteLength,
      summary: title.slice(0, 500),
      firstPageSummary: title.slice(0, 500),
      ...(input.citationMap ? { citationMap: input.citationMap } : {}),
    },
    select: { id: true, filename: true },
  });
  return { documentId: doc.id, filename: doc.filename };
}

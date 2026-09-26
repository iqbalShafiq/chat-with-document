import { randomUUID } from "node:crypto";
import { prisma } from "../../utils/prisma.js";
import { buildDocumentR2Key, deleteObject, getObjectBuffer, putObject } from "../../lib/r2.js";
import { artifactWhere } from "../artifacts/scope.js";
import {
  buildReportPdf,
  type ReportCitation,
  type ReportRasterAsset,
} from "./service.js";

/** Frozen report inputs persisted on the Document row (kind "report"). */
export type ReportSource = {
  markdown: string;
  svgAssets?: string[];
  imageIds?: string[];
};

function sanitizeTitle(title: string): string {
  return title.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "report";
}

export async function createReport(input: {
  userId: string;
  sessionId: string;
  title: string;
  markdown: string;
  svgAssets?: string[];
  imageIds?: string[];
  rasterAssets?: ReportRasterAsset[];
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
    rasterAssets: input.rasterAssets,
    citationMap: input.citationMap,
  });
  const filename = `${sanitizeTitle(input.title)}.pdf`;
  const documentId = randomUUID();
  const r2Key = buildDocumentR2Key(input.userId, input.sessionId, documentId, filename);
  await putObject(r2Key, Buffer.from(pdf), "application/pdf");
  const reportSource: ReportSource = {
    markdown: input.markdown,
    ...(input.svgAssets?.length ? { svgAssets: input.svgAssets } : {}),
    ...(input.imageIds?.length ? { imageIds: input.imageIds } : {}),
  };
  let doc: { id: string; filename: string };
  try {
    doc = await prisma.document.create({
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
        reportSource,
        ...(input.citationMap ? { citationMap: input.citationMap } : {}),
      },
      select: { id: true, filename: true },
    });
  } catch (error) {
    // Never leave an orphan object when the row cannot be created.
    await deleteObject(r2Key).catch((cleanupError) => {
      console.warn("[reports] orphan PDF cleanup failed", { r2Key, error: cleanupError });
    });
    throw error;
  }
  await prisma.documentSession.create({
    data: { documentId: doc.id, sessionId: input.sessionId, userId: input.userId },
  });
  return { documentId: doc.id, filename: doc.filename };
}

/**
 * Revise the same report in place. Omitted parts reuse the frozen
 * `reportSource`, so a title-only edit never destroys the body; cross-scope
 * ids yield not-found (never reveal other scopes).
 */
export async function editReport(input: {
  userId: string;
  sessionId: string;
  documentId: string;
  title?: string;
  markdown?: string;
  svgAssets?: string[];
  imageIds?: string[];
  citationMap?: ReportCitation[];
  /** Re-fetch stored raster assets (image store) for a full re-render. */
  fetchRasterAssets?: (imageIds: string[]) => Promise<ReportRasterAsset[]>;
}): Promise<{ documentId: string; filename: string }> {
  const session = await prisma.chatSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: { id: true, projectId: true },
  });
  if (!session) throw new Error("Session not found");
  const scope = artifactWhere(input.userId, session.projectId ?? null);
  const existing = await prisma.document.findFirst({
    where: { ...scope, id: input.documentId, kind: "report" },
    select: { id: true, filename: true, r2Key: true, reportSource: true },
  });
  if (!existing) throw new Error("Report not found");
  const source = (existing.reportSource ?? null) as ReportSource | null;
  const title = input.title?.trim() || existing.filename.replace(/\.pdf$/, "");
  const markdown = input.markdown ?? source?.markdown ?? "";
  const svgAssets = input.svgAssets ?? source?.svgAssets;
  const imageIds = input.imageIds ?? source?.imageIds ?? [];
  const rasterAssets =
    input.fetchRasterAssets && imageIds.length > 0
      ? await input.fetchRasterAssets(imageIds).catch((error) => {
          console.warn("[reports] raster re-fetch failed for edit", { imageIds, error });
          return [] as ReportRasterAsset[];
        })
      : undefined;
  const pdf = await buildReportPdf({
    title,
    markdown,
    svgAssets,
    rasterAssets,
    citationMap: input.citationMap,
  });
  await putObject(existing.r2Key, Buffer.from(pdf), "application/pdf");
  const nextFilename =
    title === existing.filename.replace(/\.pdf$/, "")
      ? existing.filename
      : `${sanitizeTitle(title)}.pdf`;
  const reportSource: ReportSource = {
    markdown,
    ...(svgAssets?.length ? { svgAssets } : {}),
    ...(imageIds.length ? { imageIds } : {}),
  };
  const doc = await prisma.document.update({
    where: { id: existing.id },
    data: {
      filename: nextFilename,
      sizeBytes: pdf.byteLength,
      summary: title.slice(0, 500),
      firstPageSummary: title.slice(0, 500),
      reportSource,
      ...(input.citationMap ? { citationMap: input.citationMap } : {}),
    },
    select: { id: true, filename: true },
  });
  return { documentId: doc.id, filename: doc.filename };
}

/**
 * Serve a report PDF for in-chat preview. Scoped like every report read:
 * out-of-scope or non-report ids yield null.
 */
export async function getReportFile(input: {
  userId: string;
  sessionId: string;
  documentId: string;
}): Promise<{ bytes: Uint8Array; filename: string; mimeType: string } | null> {
  const session = await prisma.chatSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: { id: true, projectId: true },
  });
  if (!session) return null;
  const scope = artifactWhere(input.userId, session.projectId ?? null);
  const existing = await prisma.document.findFirst({
    where: {
      ...scope,
      id: input.documentId,
      kind: "report",
      status: "ready",
    },
    select: { r2Key: true, filename: true, mimeType: true },
  });
  if (!existing) return null;
  const bytes = await getObjectBuffer(existing.r2Key);
  return {
    bytes: new Uint8Array(bytes),
    filename: existing.filename,
    mimeType: existing.mimeType || "application/pdf",
  };
}

import { prisma } from "../../utils/prisma.js";
import { artifactWhere } from "./scope.js";
import { createDefaultMemoryScopeKey } from "../chat/memory-scope.js";
import { getScopedSite, listSitesByScope } from "../static-sites/service.js";
import { extractSiteExcerpt } from "../static-sites/viewing.js";

export const ARTIFACT_TYPES = [
  "document",
  "image",
  "site",
  "web_bundle",
  "task",
  "schedule",
  "session",
] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export function isArtifactType(value: unknown): value is ArtifactType {
  return (
    typeof value === "string" &&
    (ARTIFACT_TYPES as readonly string[]).includes(value)
  );
}

type PrismaSurface = Pick<
  typeof prisma,
  | "document"
  | "generatedImage"
  | "webBundle"
  | "workspaceTask"
  | "workspaceSchedule"
  | "chatSession"
  | "agentMemorySession"
  | "agentMemoryMessage"
>;

export async function resolveSessionScope(
  input: { userId: string; sessionId?: string | null },
  deps: { prisma: Pick<typeof prisma, "chatSession"> } = { prisma },
): Promise<string | null> {
  if (!input.sessionId) return null;
  const session = await deps.prisma.chatSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: { projectId: true },
  });
  if (!session) throw new Error("Session not found");
  return session.projectId ?? null;
}

export async function listArtifacts(
  input: {
    userId: string;
    sessionProjectId: string | null;
    type?: ArtifactType;
    q?: string;
  },
  deps: { prisma: PrismaSurface } = { prisma },
): Promise<{ items: Array<Record<string, unknown>> }> {
  const where = artifactWhere(input.userId, input.sessionProjectId);
  const q = input.q?.trim();
  const types: ArtifactType[] = input.type ? [input.type] : [...ARTIFACT_TYPES];
  const items: Array<Record<string, unknown>> = [];

  if (types.includes("document")) {
    const docs = await deps.prisma.document.findMany({
      where: {
        ...where,
        ...(q
          ? { filename: { contains: q, mode: "insensitive" } }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, filename: true, kind: true, projectId: true, createdAt: true },
    });
    for (const d of docs) items.push({ type: "document", ...d });
  }
  if (types.includes("image")) {
    const images = await deps.prisma.generatedImage.findMany({
      where: {
        ...where,
        ...(q
          ? {
              OR: [
                { caption: { contains: q, mode: "insensitive" } },
                { prompt: { contains: q, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        caption: true,
        prompt: true,
        projectId: true,
        sessionId: true,
        source: true,
        createdAt: true,
      },
    });
    for (const i of images) items.push({ type: "image", ...i });
  }
  if (types.includes("site")) {
    const sites = await listSitesByScope(input.userId, input.sessionProjectId);
    for (const s of sites) {
      if (q && !s.siteId.toLowerCase().includes(q.toLowerCase())) continue;
      items.push({ type: "site", id: s.siteId, ...s });
    }
  }
  if (types.includes("web_bundle")) {
    const bundles = await deps.prisma.webBundle.findMany({
      where: { ...where, ...(q ? { title: { contains: q, mode: "insensitive" } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    for (const b of bundles) items.push({ type: "web_bundle", ...b });
  }
  if (types.includes("task")) {
    const tasks = await deps.prisma.workspaceTask.findMany({
      where: { ...where, ...(q ? { title: { contains: q, mode: "insensitive" } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    for (const t of tasks) items.push({ type: "task", ...t });
  }
  if (types.includes("schedule")) {
    const schedules = await deps.prisma.workspaceSchedule.findMany({
      where: { ...where, ...(q ? { title: { contains: q, mode: "insensitive" } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    for (const s of schedules) items.push({ type: "schedule", ...s });
  }
  if (types.includes("session")) {
    const sessions = await deps.prisma.chatSession.findMany({
      where: input.sessionProjectId
        ? {
            userId: input.userId,
            projectId: input.sessionProjectId,
            ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
          }
        : {
            userId: input.userId,
            projectId: null,
            ...(q ? { title: { contains: q, mode: "insensitive" as const } } : {}),
          },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: { id: true, title: true, projectId: true, updatedAt: true },
    });
    for (const s of sessions) items.push({ type: "session", sessionId: s.id, ...s });
  }
  return { items };
}

export async function updateImageCaption(
  input: { userId: string; sessionId: string; imageId: string; caption: string },
  deps: { prisma: Pick<typeof prisma, "generatedImage" | "chatSession"> } = { prisma },
): Promise<{ id: string; caption: string }> {
  const caption = input.caption.trim();
  if (caption.length < 1 || caption.length > 280) {
    throw new Error("Caption must be 1-280 characters.");
  }
  const session = await deps.prisma.chatSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: { projectId: true },
  });
  if (!session) throw new Error("Session not found");
  const scope = artifactWhere(input.userId, session.projectId ?? null);
  const image = await deps.prisma.generatedImage.findFirst({
    where: { ...scope, id: input.imageId },
    select: { id: true },
  });
  if (!image) throw new Error("Image not found");
  const updated = await deps.prisma.generatedImage.update({
    where: { id: image.id },
    data: { caption },
    select: { id: true, caption: true },
  });
  return updated;
}

export async function getArtifact(
  input: {
    userId: string;
    sessionProjectId: string | null;
    type: ArtifactType;
    id: string;
  },
  deps: { prisma: PrismaSurface } = { prisma },
): Promise<Record<string, unknown> | null> {
  const where = artifactWhere(input.userId, input.sessionProjectId);
  switch (input.type) {
    case "document": {
      const doc = await deps.prisma.document.findFirst({
        where: { ...where, id: input.id },
        select: {
          id: true,
          filename: true,
          kind: true,
          projectId: true,
          pageCount: true,
          createdAt: true,
        },
      });
      return doc ? { type: "document", ...doc } : null;
    }
    case "image": {
      const image = await deps.prisma.generatedImage.findFirst({
        where: { ...where, id: input.id },
        select: {
          id: true,
          caption: true,
          prompt: true,
          projectId: true,
          sessionId: true,
          source: true,
          mediaType: true,
          createdAt: true,
        },
      });
      return image ? { type: "image", ...image } : null;
    }
    case "site": {
      const manifest = await getScopedSite(input.userId, input.sessionProjectId, input.id);
      const excerpt = manifest
        ? await extractSiteExcerpt({
            ref: { siteId: manifest.siteId, version: manifest.version },
            maxChars: 2000,
          }).catch(() => null)
        : null;
      return manifest
        ? {
            type: "site",
            id: manifest.siteId,
            siteId: manifest.siteId,
            version: manifest.version,
            stableVersion: manifest.stableVersion,
            status: manifest.status,
            previewUrl: manifest.previewUrl,
            projectId: input.sessionProjectId,
            updatedAt: manifest.updatedAt,
            ...(excerpt ? { excerpt: excerpt.excerpt } : {}),
          }
        : null;
    }
    case "web_bundle": {
      const bundle = await deps.prisma.webBundle.findFirst({
        where: { ...where, id: input.id },
      });
      return bundle ? { type: "web_bundle", ...bundle } : null;
    }
    case "task": {
      const task = await deps.prisma.workspaceTask.findFirst({
        where: { ...where, id: input.id },
      });
      return task ? { type: "task", ...task } : null;
    }
    case "schedule": {
      const schedule = await deps.prisma.workspaceSchedule.findFirst({
        where: { ...where, id: input.id },
      });
      return schedule ? { type: "schedule", ...schedule } : null;
    }
    case "session": {
      const session = await deps.prisma.chatSession.findFirst({
        where: input.sessionProjectId
          ? { id: input.id, userId: input.userId, projectId: input.sessionProjectId }
          : { id: input.id, userId: input.userId, projectId: null },
        select: { id: true, title: true, projectId: true, updatedAt: true },
      });
      return session ? { type: "session", sessionId: session.id, ...session } : null;
    }
  }
}

function excerptText(message: unknown): string {
  try {
    const text = JSON.stringify(message);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "";
  }
}

/**
 * Last-N-turn excerpt of a sibling session (same scope only). Bounded,
 * read-only, never a full dump.
 */
export async function getSessionExcerpt(
  input: { userId: string; sessionProjectId: string | null; sessionId: string; limit?: number },
  deps: { prisma: PrismaSurface } = { prisma },
): Promise<{ sessionId: string; title: string | null; messages: Array<{ role: string; text: string }> } | null> {
  const session = await deps.prisma.chatSession.findFirst({
    where: input.sessionProjectId
      ? { id: input.sessionId, userId: input.userId, projectId: input.sessionProjectId }
      : { id: input.sessionId, userId: input.userId, projectId: null },
    select: { id: true, title: true },
  });
  if (!session) return null;
  const memory = await deps.prisma.agentMemorySession.findFirst({
    where: { scopeKey: createDefaultMemoryScopeKey(input.sessionId, input.userId) },
    select: { id: true },
  });
  if (!memory) return { sessionId: session.id, title: session.title, messages: [] };
  const rows = await deps.prisma.agentMemoryMessage.findMany({
    where: { memorySessionId: memory.id },
    orderBy: { position: "desc" },
    take: Math.min(Math.max(input.limit ?? 6, 1), 20),
    select: { role: true, message: true },
  });
  return {
    sessionId: session.id,
    title: session.title,
    messages: rows.reverse().map((row) => ({ role: row.role, text: excerptText(row.message) })),
  };
}

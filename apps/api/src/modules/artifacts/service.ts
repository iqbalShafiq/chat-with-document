import { prisma } from "../../utils/prisma.js";
import { artifactWhere } from "./scope.js";

export const ARTIFACT_TYPES = [
  "document",
  "image",
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
        ? { userId: input.userId, projectId: input.sessionProjectId }
        : { userId: input.userId, projectId: null },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: { id: true, title: true, projectId: true, updatedAt: true },
    });
    for (const s of sessions) items.push({ type: "session", sessionId: s.id, ...s });
  }
  return { items };
}

export async function updateImageCaption(
  input: { userId: string; imageId: string; caption: string },
  deps: { prisma: Pick<typeof prisma, "generatedImage"> } = { prisma },
): Promise<{ id: string; caption: string }> {
  const caption = input.caption.trim();
  if (caption.length < 1 || caption.length > 280) {
    throw new Error("Caption must be 1-280 characters.");
  }
  const image = await deps.prisma.generatedImage.findFirst({
    where: { id: input.imageId, userId: input.userId },
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

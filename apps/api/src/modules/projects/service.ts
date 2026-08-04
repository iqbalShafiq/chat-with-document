import { deleteDocumentChunks } from "@assingment/agent";
import { prisma } from "../../utils/prisma.js";
import { deleteObject } from "../../lib/r2.js";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

export type ProjectListItem = {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  chatCount: number;
  lastOpenedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProjectListPage = {
  items: ProjectListItem[];
  nextCursor: string | null;
};

export type ProjectDetail = ProjectListItem;

export class ProjectNotFoundError extends Error {
  readonly code = "PROJECT_NOT_FOUND";
  constructor(message = "Project not found") {
    super(message);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectConfirmRequiredError extends Error {
  readonly code = "CONFIRM_REQUIRED";
  constructor(message = "Cascade delete requires confirm=true") {
    super(message);
    this.name = "ProjectConfirmRequiredError";
  }
}

function clampLimit(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
    }
  }
  return DEFAULT_LIMIT;
}

/** Cursor: `${isoUpdatedAt}|${projectId}` */
function decodeCursor(
  raw: string | undefined,
): { updatedAt: Date; id: string } | null {
  if (!raw) return null;
  const sep = raw.indexOf("|");
  if (sep <= 0) return null;
  const updatedAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!id || Number.isNaN(updatedAt.getTime())) return null;
  return { updatedAt, id };
}

function encodeCursor(updatedAt: Date, id: string): string {
  return `${updatedAt.toISOString()}|${id}`;
}

type SortKey = "lastOpenedAt" | "updatedAt" | "name";

function parseSort(raw: string | undefined): SortKey {
  if (raw === "lastOpenedAt" || raw === "name" || raw === "updatedAt") {
    return raw;
  }
  return "updatedAt";
}

function toListItem(
  row: {
    id: string;
    name: string;
    description: string | null;
    lastOpenedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
    _count: { documents: number; chats: number };
  },
): ProjectListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    documentCount: row._count.documents,
    chatCount: row._count.chats,
    lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listProjects(input: {
  userId: string;
  query?: string;
  cursor?: string;
  limit?: string | number;
  sort?: string;
}): Promise<ProjectListPage> {
  const limit = clampLimit(input.limit);
  const sort = parseSort(input.sort);
  const q = input.query?.trim() ?? "";
  const cursor = decodeCursor(input.cursor);

  const where: {
    userId: string;
    AND?: Array<Record<string, unknown>>;
  } = { userId: input.userId };

  const andFilters: Array<Record<string, unknown>> = [];

  if (q) {
    andFilters.push({
      OR: [
        { name: { contains: q, mode: "insensitive" as const } },
        { description: { contains: q, mode: "insensitive" as const } },
      ],
    });
  }

  // Cursor pagination only for updatedAt / lastOpenedAt (personal-scale lists).
  // Name sort is first-page only for v1 simplicity when cursor is present we ignore name.
  if (cursor && sort !== "name") {
    const field = sort === "lastOpenedAt" ? "lastOpenedAt" : "updatedAt";
    andFilters.push({
      OR: [
        { [field]: { lt: cursor.updatedAt } },
        {
          AND: [{ [field]: cursor.updatedAt }, { id: { lt: cursor.id } }],
        },
      ],
    });
  }

  if (andFilters.length > 0) {
    where.AND = andFilters;
  }

  const orderBy =
    sort === "name"
      ? [{ name: "asc" as const }, { id: "asc" as const }]
      : sort === "lastOpenedAt"
        ? [
            { lastOpenedAt: { sort: "desc" as const, nulls: "last" as const } },
            { id: "desc" as const },
          ]
        : [{ updatedAt: "desc" as const }, { id: "desc" as const }];

  const rows = await prisma.project.findMany({
    where,
    orderBy,
    take: limit + 1,
    select: {
      id: true,
      name: true,
      description: true,
      lastOpenedAt: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          documents: true,
          chats: true,
        },
      },
    },
  });

  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = pageRows[pageRows.length - 1];

  let nextCursor: string | null = null;
  if (hasMore && last && sort !== "name") {
    // lastOpenedAt sort: only emit cursor when stamp is real lastOpenedAt so
    // filter field matches encode (null lastOpenedAt rows are not pageable).
    if (sort === "lastOpenedAt") {
      if (last.lastOpenedAt) {
        nextCursor = encodeCursor(last.lastOpenedAt, last.id);
      }
    } else {
      nextCursor = encodeCursor(last.updatedAt, last.id);
    }
  }

  return {
    items: pageRows.map(toListItem),
    nextCursor,
  };
}

export async function createProject(input: {
  userId: string;
  name: string;
  description?: string | null;
}): Promise<ProjectDetail> {
  const name = input.name.trim();
  if (!name) {
    throw new Error("name is required");
  }
  if (name.length > 120) {
    throw new Error("name must be at most 120 characters");
  }

  const description =
    typeof input.description === "string" && input.description.trim()
      ? input.description.trim().slice(0, 2000)
      : null;

  const row = await prisma.project.create({
    data: {
      userId: input.userId,
      name,
      description,
    },
    select: {
      id: true,
      name: true,
      description: true,
      lastOpenedAt: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: { documents: true, chats: true },
      },
    },
  });

  return toListItem(row);
}

export async function getProject(
  userId: string,
  projectId: string,
): Promise<ProjectDetail> {
  const row = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: {
      id: true,
      name: true,
      description: true,
      lastOpenedAt: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: { documents: true, chats: true },
      },
    },
  });

  if (!row) throw new ProjectNotFoundError();
  return toListItem(row);
}

export async function updateProject(input: {
  userId: string;
  projectId: string;
  name?: string;
  description?: string | null;
}): Promise<ProjectDetail> {
  const existing = await prisma.project.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: { id: true },
  });
  if (!existing) throw new ProjectNotFoundError();

  const data: { name?: string; description?: string | null } = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("name is required");
    if (name.length > 120) throw new Error("name must be at most 120 characters");
    data.name = name;
  }
  if (input.description !== undefined) {
    data.description =
      input.description === null || input.description.trim() === ""
        ? null
        : input.description.trim().slice(0, 2000);
  }

  const row = await prisma.project.update({
    where: { id: input.projectId },
    data,
    select: {
      id: true,
      name: true,
      description: true,
      lastOpenedAt: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: { documents: true, chats: true },
      },
    },
  });

  return toListItem(row);
}

/** Touch lastOpenedAt when user opens a project workspace. */
export async function openProject(
  userId: string,
  projectId: string,
): Promise<ProjectDetail> {
  const existing = await prisma.project.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!existing) throw new ProjectNotFoundError();

  const row = await prisma.project.update({
    where: { id: projectId },
    data: { lastOpenedAt: new Date() },
    select: {
      id: true,
      name: true,
      description: true,
      lastOpenedAt: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: { documents: true, chats: true },
      },
    },
  });

  return toListItem(row);
}

/**
 * Cascade-delete a project and all project chats/docs/memory.
 * Standalone rows (projectId IS NULL) are never touched.
 * External R2/Qdrant cleanup runs after the DB transaction (best-effort).
 */
export async function deleteProject(input: {
  userId: string;
  projectId: string;
  confirm: boolean;
}): Promise<{ deleted: true; documentCount: number; chatCount: number }> {
  if (!input.confirm) {
    throw new ProjectConfirmRequiredError();
  }

  const project = await prisma.project.findFirst({
    where: { id: input.projectId, userId: input.userId },
    select: {
      id: true,
      documents: { select: { id: true, r2Key: true } },
      chats: { select: { id: true } },
    },
  });

  if (!project) throw new ProjectNotFoundError();

  const documentIds = project.documents.map((d) => d.id);
  const r2Keys = project.documents.map((d) => d.r2Key).filter(Boolean);
  const sessionIds = project.chats.map((c) => c.id);

  await prisma.$transaction(async (tx) => {
    if (sessionIds.length > 0) {
      await tx.agentUsageEvent.deleteMany({
        where: { userId: input.userId, sessionId: { in: sessionIds } },
      });
      await tx.agentMemorySession.deleteMany({
        where: { userId: input.userId, sessionId: { in: sessionIds } },
      });
      // DocumentSession has no FK to ChatSession — clear links before chat rows go.
      await tx.documentSession.deleteMany({
        where: { userId: input.userId, sessionId: { in: sessionIds } },
      });
    }

    // Documents cascade pages + remaining session links via FK; ChatSession cascades from Project.
    // Explicit document delete first so we control order with usage/memory above.
    if (documentIds.length > 0) {
      await tx.document.deleteMany({
        where: { id: { in: documentIds }, userId: input.userId, projectId: input.projectId },
      });
    }

    await tx.chatSession.deleteMany({
      where: { projectId: input.projectId, userId: input.userId },
    });

    await tx.project.delete({
      where: { id: input.projectId },
    });
  });

  // Best-effort external cleanup (do not fail the API if one object is missing).
  for (const key of r2Keys) {
    try {
      await deleteObject(key);
    } catch (error) {
      console.error("[projects] R2 delete failed", { key, error });
    }
  }
  for (const documentId of documentIds) {
    try {
      await deleteDocumentChunks(documentId);
    } catch (error) {
      console.error("[projects] Qdrant delete failed", { documentId, error });
    }
  }

  return {
    deleted: true,
    documentCount: documentIds.length,
    chatCount: sessionIds.length,
  };
}

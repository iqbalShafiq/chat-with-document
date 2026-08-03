import { prisma } from "../../utils/prisma.js";
import { buildDocumentR2Key, putObject } from "../../lib/r2.js";
import { getDocumentIngestQueue } from "../../lib/queue.js";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Per-user total document storage cap (all sessions). */
export const MAX_USER_STORAGE_BYTES = 200 * 1024 * 1024;

const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

const DEFAULT_LIBRARY_LIMIT = 20;
const MAX_LIBRARY_LIMIT = 50;

export class DocumentStorageQuotaError extends Error {
  readonly code = "STORAGE_QUOTA_EXCEEDED";
  readonly usedBytes: number;
  readonly maxBytes: number;
  readonly fileBytes: number;

  constructor(input: {
    usedBytes: number;
    maxBytes: number;
    fileBytes: number;
  }) {
    super(
      `Storage limit exceeded (${formatBytes(input.usedBytes + input.fileBytes)} / ${formatBytes(input.maxBytes)}). Delete documents or free space before uploading.`,
    );
    this.name = "DocumentStorageQuotaError";
    this.usedBytes = input.usedBytes;
    this.maxBytes = input.maxBytes;
    this.fileBytes = input.fileBytes;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clampLimit(value: unknown, fallback: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(max, Math.max(1, Math.floor(value)));
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.min(max, Math.max(1, Math.floor(parsed)));
    }
  }
  return fallback;
}

/** Cursor format: `${isoCreatedAt}|${documentId}` */
function decodeLibraryCursor(
  raw: string | undefined,
): { createdAt: Date; id: string } | null {
  if (!raw) return null;
  const sep = raw.indexOf("|");
  if (sep <= 0) return null;
  const createdAt = new Date(raw.slice(0, sep));
  const id = raw.slice(sep + 1);
  if (!id || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}

function encodeLibraryCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}|${id}`;
}

export async function getUserStorageUsage(userId: string): Promise<{
  usedBytes: number;
  maxBytes: number;
  remainingBytes: number;
}> {
  const aggregate = await prisma.document.aggregate({
    where: { userId },
    _sum: { sizeBytes: true },
  });
  const usedBytes = aggregate._sum.sizeBytes ?? 0;
  return {
    usedBytes,
    maxBytes: MAX_USER_STORAGE_BYTES,
    remainingBytes: Math.max(0, MAX_USER_STORAGE_BYTES - usedBytes),
  };
}

async function ensureSessionLink(input: {
  documentId: string;
  sessionId: string;
  userId: string;
}) {
  await prisma.documentSession.upsert({
    where: {
      documentId_sessionId: {
        documentId: input.documentId,
        sessionId: input.sessionId,
      },
    },
    create: {
      documentId: input.documentId,
      sessionId: input.sessionId,
      userId: input.userId,
    },
    update: {},
  });
}

export async function createDocumentUpload(input: {
  userId: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  data: Uint8Array;
  /** Optional project corpus membership. Validated against ownership when set. */
  projectId?: string | null;
}) {
  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    throw new Error("Unsupported file type");
  }
  if (input.data.byteLength > MAX_FILE_BYTES) {
    throw new Error("File exceeds 10MB limit");
  }
  if (input.data.byteLength === 0) {
    throw new Error("File is empty");
  }

  let projectId: string | null = null;
  if (input.projectId) {
    const project = await prisma.project.findFirst({
      where: { id: input.projectId, userId: input.userId },
      select: { id: true },
    });
    if (!project) {
      throw new Error("Project not found");
    }
    projectId = project.id;
  }

  // If the chat session is in a project, prefer that membership when client omits projectId.
  if (!projectId) {
    const chat = await prisma.chatSession.findFirst({
      where: { id: input.sessionId, userId: input.userId },
      select: { projectId: true },
    });
    if (chat?.projectId) {
      projectId = chat.projectId;
    }
  }

  const storage = await getUserStorageUsage(input.userId);
  if (storage.usedBytes + input.data.byteLength > storage.maxBytes) {
    throw new DocumentStorageQuotaError({
      usedBytes: storage.usedBytes,
      maxBytes: storage.maxBytes,
      fileBytes: input.data.byteLength,
    });
  }

  const document = await prisma.document.create({
    data: {
      userId: input.userId,
      sessionId: input.sessionId,
      projectId,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.data.byteLength,
      r2Key: "",
      status: "uploading",
      sessionLinks: {
        create: {
          sessionId: input.sessionId,
          userId: input.userId,
        },
      },
    },
  });

  const r2Key = buildDocumentR2Key(
    input.userId,
    input.sessionId,
    document.id,
    input.filename,
  );

  await putObject(r2Key, input.data, input.mimeType);

  await prisma.document.update({
    where: { id: document.id },
    data: { r2Key, status: "queued" },
  });

  await getDocumentIngestQueue().add(
    "ingest",
    {
      documentId: document.id,
      userId: input.userId,
      sessionId: input.sessionId,
      r2Key,
      filename: input.filename,
      mimeType: input.mimeType,
    },
    { jobId: document.id },
  );

  return {
    id: document.id,
    filename: document.filename,
    status: "queued" as const,
    sizeBytes: document.sizeBytes,
  };
}

export async function getDocumentStatus(input: {
  userId: string;
  sessionId?: string;
  documentId: string;
}) {
  const document = await prisma.document.findFirst({
    where: {
      id: input.documentId,
      userId: input.userId,
      ...(input.sessionId
        ? {
            OR: [
              { sessionId: input.sessionId },
              {
                sessionLinks: {
                  some: { sessionId: input.sessionId, userId: input.userId },
                },
              },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      filename: true,
      status: true,
      pageCount: true,
      errorMessage: true,
      firstPageSummary: true,
      sizeBytes: true,
    },
  });

  return document;
}

/** Ready documents linked to a chat session (active docs). */
export async function listSessionDocuments(sessionId: string, userId: string) {
  const links = await prisma.documentSession.findMany({
    where: {
      sessionId,
      userId,
      document: { status: "ready", userId },
    },
    orderBy: { createdAt: "asc" },
    select: {
      document: {
        select: {
          id: true,
          filename: true,
          firstPageSummary: true,
          sizeBytes: true,
          mimeType: true,
          pageCount: true,
        },
      },
    },
  });

  return links.map((link) => link.document);
}

/**
 * Active docs for the agent: session links, intersected with project corpus when
 * the chat belongs to a project. Standalone chats use session links only.
 */
export async function resolveActiveDocuments(input: {
  userId: string;
  sessionId: string;
  projectId: string | null;
}) {
  const links = await prisma.documentSession.findMany({
    where: {
      sessionId: input.sessionId,
      userId: input.userId,
      document: {
        status: "ready",
        userId: input.userId,
        ...(input.projectId
          ? { projectId: input.projectId }
          : { projectId: null }),
      },
    },
    orderBy: { createdAt: "asc" },
    select: {
      document: {
        select: {
          id: true,
          filename: true,
          firstPageSummary: true,
          sizeBytes: true,
          mimeType: true,
          pageCount: true,
        },
      },
    },
  });

  return links.map((link) => link.document);
}

export type UserDocumentLibraryItem = {
  id: string;
  filename: string;
  firstPageSummary: string;
  sizeBytes: number;
  mimeType: string;
  pageCount: number;
  createdAt: string;
  /** Origin session id (upload site). */
  originSessionId: string;
  projectId: string | null;
  projectName: string | null;
};

export type UserDocumentLibraryPage = {
  items: UserDocumentLibraryItem[];
  nextCursor: string | null;
};

export type LibraryScope = "attach" | "browser";

export async function listUserDocuments(input: {
  userId: string;
  query?: string;
  cursor?: string;
  limit?: number | string;
  /**
   * attach (default): attach modal source.
   *  - with projectId → only that project corpus
   *  - without → standalone only (projectId IS NULL)
   * browser: all ready docs for Documents page (includes project labels)
   */
  scope?: LibraryScope;
  projectId?: string | null;
}): Promise<UserDocumentLibraryPage> {
  const limit = clampLimit(
    input.limit,
    DEFAULT_LIBRARY_LIMIT,
    MAX_LIBRARY_LIMIT,
  );
  const cursor = decodeLibraryCursor(input.cursor);
  const q = input.query?.trim() ?? "";
  const scope: LibraryScope = input.scope === "browser" ? "browser" : "attach";

  const andFilters: Array<Record<string, unknown>> = [];
  if (q) {
    andFilters.push({
      OR: [
        { filename: { contains: q, mode: "insensitive" as const } },
        { summary: { contains: q, mode: "insensitive" as const } },
        {
          firstPageSummary: {
            contains: q,
            mode: "insensitive" as const,
          },
        },
      ],
    });
  }
  if (cursor) {
    andFilters.push({
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        {
          AND: [
            { createdAt: cursor.createdAt },
            { id: { lt: cursor.id } },
          ],
        },
      ],
    });
  }

  // Membership filter for attach vs browser
  if (scope === "attach") {
    if (input.projectId) {
      andFilters.push({ projectId: input.projectId });
    } else {
      andFilters.push({ projectId: null });
    }
  }

  const rows = await prisma.document.findMany({
    where: {
      userId: input.userId,
      status: "ready",
      ...(andFilters.length > 0 ? { AND: andFilters } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      filename: true,
      firstPageSummary: true,
      sizeBytes: true,
      mimeType: true,
      pageCount: true,
      createdAt: true,
      sessionId: true,
      projectId: true,
      project: { select: { name: true } },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map((doc) => ({
      id: doc.id,
      filename: doc.filename,
      firstPageSummary: doc.firstPageSummary,
      sizeBytes: doc.sizeBytes,
      mimeType: doc.mimeType,
      pageCount: doc.pageCount,
      createdAt: doc.createdAt.toISOString(),
      originSessionId: doc.sessionId,
      projectId: doc.projectId,
      projectName: doc.project?.name ?? null,
    })),
    nextCursor:
      hasMore && last
        ? encodeLibraryCursor(last.createdAt, last.id)
        : null,
  };
}

export async function linkDocumentsToSession(input: {
  userId: string;
  sessionId: string;
  documentIds: string[];
}) {
  const uniqueIds = [...new Set(input.documentIds.map((id) => id.trim()))].filter(
    Boolean,
  );
  if (uniqueIds.length === 0) {
    return { linked: [] as Awaited<ReturnType<typeof listSessionDocuments>> };
  }

  const chat = await prisma.chatSession.findFirst({
    where: { id: input.sessionId, userId: input.userId },
    select: { projectId: true },
  });
  // No ChatSession yet → treat as standalone (legacy / first open).
  const projectId = chat?.projectId ?? null;

  const owned = await prisma.document.findMany({
    where: {
      userId: input.userId,
      id: { in: uniqueIds },
      status: "ready",
      // Hard isolation: only same corpus membership may be linked.
      projectId,
    },
    select: { id: true },
  });

  if (owned.length === 0) {
    return { linked: [] as Awaited<ReturnType<typeof listSessionDocuments>> };
  }

  await prisma.$transaction(
    owned.map((doc) =>
      prisma.documentSession.upsert({
        where: {
          documentId_sessionId: {
            documentId: doc.id,
            sessionId: input.sessionId,
          },
        },
        create: {
          documentId: doc.id,
          sessionId: input.sessionId,
          userId: input.userId,
        },
        update: {},
      }),
    ),
  );

  const linked = await listSessionDocuments(input.sessionId, input.userId);
  return { linked };
}

export async function unlinkDocumentFromSession(input: {
  userId: string;
  sessionId: string;
  documentId: string;
}) {
  const result = await prisma.documentSession.deleteMany({
    where: {
      userId: input.userId,
      sessionId: input.sessionId,
      documentId: input.documentId,
    },
  });

  return { ok: true as const, removed: result.count > 0 };
}

export async function getDocumentPreview(input: {
  userId: string;
  documentId: string;
  pageIndex?: number;
  pageLimit?: number;
}) {
  const document = await prisma.document.findFirst({
    where: {
      id: input.documentId,
      userId: input.userId,
      status: "ready",
    },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      pageCount: true,
      sizeBytes: true,
      firstPageSummary: true,
      summary: true,
    },
  });

  if (!document) return null;

  const pageLimit = clampLimit(input.pageLimit, 1, 5);
  const startPage =
    typeof input.pageIndex === "number" &&
    Number.isInteger(input.pageIndex) &&
    input.pageIndex >= 0
      ? input.pageIndex
      : 0;

  const pages = await prisma.documentPage.findMany({
    where: {
      documentId: document.id,
      pageIndex: {
        gte: startPage,
        lt: startPage + pageLimit,
      },
    },
    orderBy: { pageIndex: "asc" },
    select: {
      pageIndex: true,
      summary: true,
      rawMarkdown: true,
    },
  });

  return {
    id: document.id,
    filename: document.filename,
    mimeType: document.mimeType,
    pageCount: document.pageCount,
    sizeBytes: document.sizeBytes,
    firstPageSummary: document.firstPageSummary,
    summary: document.summary,
    pages,
  };
}

/** Re-export for call sites that need explicit link after create paths. */
export { ensureSessionLink };

import { prisma } from "../../utils/prisma.js";
import { artifactWhere } from "../artifacts/scope.js";

export type TaskStatus = "inbox" | "doing" | "done";

export async function resolveScope(
  userId: string,
  sessionId: string | null,
): Promise<string | null> {
  if (!sessionId) return null;
  const session = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { projectId: true },
  });
  if (!session) throw new Error("Session not found");
  return session.projectId ?? null;
}

export async function listTasks(
  userId: string,
  sessionProjectId: string | null,
): Promise<{ items: unknown[] }> {
  const items = await prisma.workspaceTask.findMany({
    where: artifactWhere(userId, sessionProjectId),
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return { items };
}

export async function createTask(input: {
  userId: string;
  sessionId: string;
  title: string;
  dueAt?: string;
  sourceSessionId?: string;
}): Promise<{ id: string; title: string; status: string }> {
  const title = input.title.trim();
  if (!title || title.length > 200) throw new Error("Title must be 1-200 characters.");
  const scope = await resolveScope(input.userId, input.sessionId);
  const task = await prisma.workspaceTask.create({
    data: {
      userId: input.userId,
      projectId: scope,
      title,
      sourceSessionId: input.sourceSessionId ?? input.sessionId,
      ...(input.dueAt ? { dueAt: new Date(input.dueAt) } : {}),
    },
    select: { id: true, title: true, status: true },
  });
  return task;
}

export async function updateTask(input: {
  userId: string;
  sessionId: string;
  id: string;
  status?: TaskStatus;
  title?: string;
}): Promise<{ id: string; title: string; status: string }> {
  const scope = await resolveScope(input.userId, input.sessionId);
  const existing = await prisma.workspaceTask.findFirst({
    where: { id: input.id, userId: input.userId, projectId: scope },
    select: { id: true },
  });
  if (!existing) throw new Error("Task not found");
  if (input.status && !["inbox", "doing", "done"].includes(input.status)) {
    throw new Error("Invalid status.");
  }
  if (input.title !== undefined && (!input.title.trim() || input.title.length > 200)) {
    throw new Error("Title must be 1-200 characters.");
  }
  return prisma.workspaceTask.update({
    where: { id: existing.id },
    data: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
    },
    select: { id: true, title: true, status: true },
  });
}

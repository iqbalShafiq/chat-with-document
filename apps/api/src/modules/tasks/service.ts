import { randomUUID } from "node:crypto";
import { prisma } from "../../utils/prisma.js";
import { artifactWhere } from "../artifacts/scope.js";

export type TaskStatus = "inbox" | "doing" | "done";

export type TaskSubtask = {
  id: string;
  title: string;
  done: boolean;
};

function readSubtasks(value: unknown): TaskSubtask[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is TaskSubtask =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { title?: unknown }).title === "string" &&
        typeof (item as { done?: unknown }).done === "boolean",
    )
    .map((item) => ({ id: item.id, title: item.title, done: item.done }));
}

function cleanTitle(title: string): string {
  const clean = title.trim();
  if (!clean || clean.length > 200) throw new Error("Title must be 1-200 characters.");
  return clean;
}

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
  description?: string;
  addSubtasks?: string[];
  dueAt?: string;
  sourceSessionId?: string;
}): Promise<{ id: string; title: string; status: string }> {
  const title = cleanTitle(input.title);
  if (input.description !== undefined && input.description.length > 2000) {
    throw new Error("Description must be at most 2000 characters.");
  }
  const subtasks: TaskSubtask[] = (input.addSubtasks ?? []).map((t) => ({
    id: randomUUID(),
    title: cleanTitle(t),
    done: false,
  }));
  const scope = await resolveScope(input.userId, input.sessionId);
  const task = await prisma.workspaceTask.create({
    data: {
      userId: input.userId,
      projectId: scope,
      title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(subtasks.length > 0 ? { subtasks } : {}),
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
  description?: string | null;
  addSubtasks?: string[];
  toggleSubtasks?: { id: string; done: boolean }[];
  removeSubtasks?: string[];
}): Promise<{
  id: string;
  title: string;
  status: string;
  description: string | null;
  subtasks: TaskSubtask[];
}> {
  const scope = await resolveScope(input.userId, input.sessionId);
  const existing = await prisma.workspaceTask.findFirst({
    where: { id: input.id, userId: input.userId, projectId: scope },
    select: { id: true, description: true, subtasks: true },
  });
  if (!existing) throw new Error("Task not found");
  if (input.status && !["inbox", "doing", "done"].includes(input.status)) {
    throw new Error("Invalid status.");
  }
  if (input.title !== undefined) cleanTitle(input.title);
  if (input.description !== undefined && input.description !== null && input.description.length > 2000) {
    throw new Error("Description must be at most 2000 characters.");
  }

  let subtasks = readSubtasks(existing.subtasks);
  for (const title of input.addSubtasks ?? []) {
    subtasks.push({ id: randomUUID(), title: cleanTitle(title), done: false });
  }
  for (const toggle of input.toggleSubtasks ?? []) {
    const target = subtasks.find((s) => s.id === toggle.id);
    if (!target) throw new Error(`Subtask not found: ${toggle.id}`);
    target.done = toggle.done;
  }
  for (const removeId of input.removeSubtasks ?? []) {
    if (!subtasks.some((s) => s.id === removeId)) {
      throw new Error(`Subtask not found: ${removeId}`);
    }
    subtasks = subtasks.filter((s) => s.id !== removeId);
  }

  return prisma.workspaceTask.update({
    where: { id: existing.id },
    data: {
      ...(input.status ? { status: input.status } : {}),
      ...(input.title !== undefined ? { title: input.title.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...((input.addSubtasks ?? input.toggleSubtasks ?? input.removeSubtasks)
        ? { subtasks }
        : {}),
    },
    select: { id: true, title: true, status: true, description: true, subtasks: true },
  }) as Promise<{
    id: string;
    title: string;
    status: string;
    description: string | null;
    subtasks: TaskSubtask[];
  }>;
}

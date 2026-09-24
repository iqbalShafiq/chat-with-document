import { API_BASE, apiFetch } from "#/lib/api";

// ─── Workspace artifacts (Spec A) ────────────────────────────────────────────

export type ArtifactType =
  | "document"
  | "image"
  | "web_bundle"
  | "site"
  | "task"
  | "schedule"
  | "session";

export type ArtifactListItem = {
  type: ArtifactType;
  id?: string;
  sessionId?: string;
  title?: string;
  filename?: string;
  caption?: string;
  prompt?: string;
  projectId?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export async function listArtifacts(input: {
  sessionId?: string | null;
  type?: ArtifactType;
  q?: string;
}): Promise<ArtifactListItem[]> {
  const params = new URLSearchParams();
  if (input.sessionId) params.set("sessionId", input.sessionId);
  if (input.type) params.set("type", input.type);
  if (input.q?.trim()) params.set("q", input.q.trim());
  const qs = params.toString();
  const response = await apiFetch(`${API_BASE}/api/artifacts${qs ? `?${qs}` : ""}`);
  if (!response.ok) throw new Error("Failed to load artifacts");
  const data = (await response.json()) as { items?: unknown };
  if (!data || !Array.isArray(data.items)) throw new Error("Unexpected artifacts response shape");
  return data.items as ArtifactListItem[];
}

export async function getArtifact(input: {
  id: string;
  type: ArtifactType;
  sessionId?: string | null;
}): Promise<ArtifactListItem> {
  const params = new URLSearchParams({ type: input.type });
  if (input.sessionId) params.set("sessionId", input.sessionId);
  const response = await apiFetch(
    `${API_BASE}/api/artifacts/${encodeURIComponent(input.id)}?${params.toString()}`,
  );
  if (!response.ok) throw new Error("Artifact not found");
  const data = (await response.json()) as { artifact?: ArtifactListItem };
  if (!data?.artifact) throw new Error("Unexpected artifact response shape");
  return data.artifact;
}

export async function updateImageCaption(input: {
  imageId: string;
  sessionId: string;
  caption: string;
}): Promise<{ id: string; caption: string }> {
  const response = await apiFetch(
    `${API_BASE}/api/artifacts/images/${encodeURIComponent(input.imageId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ caption: input.caption, sessionId: input.sessionId }),
    },
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Failed to update caption");
  }
  return (await response.json()) as { id: string; caption: string };
}

export type WorkspaceTask = {
  id: string;
  title: string;
  status: "inbox" | "doing" | "done";
  sourceSessionId: string | null;
  dueAt: string | null;
  createdAt: string;
};

export async function listTasks(sessionId: string): Promise<WorkspaceTask[]> {
  const response = await apiFetch(
    `${API_BASE}/api/tasks?sessionId=${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok) throw new Error("Failed to load tasks");
  const data = (await response.json()) as { items?: WorkspaceTask[] };
  return Array.isArray(data.items) ? data.items : [];
}

export async function createTask(input: {
  sessionId: string;
  title: string;
}): Promise<WorkspaceTask> {
  const response = await apiFetch(`${API_BASE}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Failed to create task");
  }
  return (await response.json()) as WorkspaceTask;
}

export async function updateTask(
  id: string,
  input: { sessionId: string; status?: WorkspaceTask["status"]; title?: string },
): Promise<WorkspaceTask> {
  const response = await apiFetch(`${API_BASE}/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw new Error("Failed to update task");
  return (await response.json()) as WorkspaceTask;
}

export async function deleteTask(id: string, sessionId: string): Promise<void> {
  const params = new URLSearchParams({ sessionId });
  const response = await apiFetch(
    `${API_BASE}/api/tasks/${encodeURIComponent(id)}?${params.toString()}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error("Failed to delete task");
}

export type WorkspaceSchedule = {
  id: string;
  title: string;
  freq: "once" | "daily" | "weekly";
  nextRunAt: string | null;
  status: string;
};

export async function listSchedules(sessionId: string): Promise<WorkspaceSchedule[]> {
  const response = await apiFetch(
    `${API_BASE}/api/schedules?sessionId=${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok) throw new Error("Failed to load schedules");
  const data = (await response.json()) as { items?: WorkspaceSchedule[] };
  return Array.isArray(data.items) ? data.items : [];
}

export async function createSchedule(input: {
  sessionId: string;
  title: string;
  prompt: string;
  freq: WorkspaceSchedule["freq"];
}): Promise<WorkspaceSchedule> {
  const response = await apiFetch(`${API_BASE}/api/schedules`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Failed to create schedule");
  }
  return (await response.json()) as WorkspaceSchedule;
}

export async function cancelSchedule(id: string, sessionId: string): Promise<void> {
  const params = new URLSearchParams({ sessionId });
  const response = await apiFetch(
    `${API_BASE}/api/schedules/${encodeURIComponent(id)}?${params.toString()}`,
    { method: "DELETE" },
  );
  if (!response.ok) throw new Error("Failed to cancel schedule");
}

export async function createReport(input: {
  sessionId: string;
  title: string;
  markdown: string;
}): Promise<{ documentId: string; filename: string }> {
  const response = await apiFetch(`${API_BASE}/api/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? "Failed to create report");
  }
  return (await response.json()) as { documentId: string; filename: string };
}

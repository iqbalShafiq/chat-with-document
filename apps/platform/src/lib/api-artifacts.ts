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

const ARTIFACT_TYPES: readonly ArtifactType[] = [
  "document",
  "image",
  "web_bundle",
  "site",
  "task",
  "schedule",
  "session",
];

/** Runtime guard for artifact types crossing trust boundaries (storage). */
export function isArtifactType(value: unknown): value is ArtifactType {
  return (
    typeof value === "string" &&
    (ARTIFACT_TYPES as readonly string[]).includes(value)
  );
}

/**
 * Visible composer token for a pinned artifact. Must stay byte-identical
 * with `formatPinnedArtifactRef` in `@anreal/agent` (covered by the same
 * vectors in `api-artifacts.test.ts`), which the agent resolves via
 * get_artifact per PINNED_ARTIFACT_INSTRUCTION.
 */
export function formatPinnedArtifactRef(
  type: ArtifactType,
  id: string,
  label: string,
): string {
  const cleanLabel = label.trim().replace(/[\[\]]/g, "").slice(0, 80) || type;
  const cleanId = id.trim();
  return `[@${type} ${cleanLabel} (${cleanId})]`;
}

const PINNED_REF_PATTERN =
  /\[@(document|image|web_bundle|site|task|schedule|session)\s+([^\[\]]*?)\s*\(([^\s\[\]]+)\)\]/g;

export type ParsedPinnedRef = {
  type: ArtifactType;
  id: string;
  label: string;
  start: number;
  end: number;
};

/** Find pinned `[@type label (id)]` references in composer text. */
export function parsePinnedArtifactRefs(text: string): ParsedPinnedRef[] {
  const refs: ParsedPinnedRef[] = [];
  PINNED_REF_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PINNED_REF_PATTERN.exec(text)) !== null) {
    refs.push({
      type: match[1] as ArtifactType,
      label: match[2]!.trim(),
      id: match[3]!,
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return refs;
}

/**
 * Remove every pinned `[@type label (id)]` span from text, collapsing the
 * leftover whitespace. Used when references move into composer entities so
 * the textfield only shows what the user typed.
 */
export function stripPinnedArtifactRefs(text: string): string {
  const refs = parsePinnedArtifactRefs(text);
  if (refs.length === 0) return text;
  let out = text;
  for (let i = refs.length - 1; i >= 0; i--) {
    out = out.slice(0, refs[i]!.start) + out.slice(refs[i]!.end);
  }
  return out
    .replace(/[ \t]*\n[ \t]*\n[ \t]*/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * Append pinned-entity token texts to a message, skipping tokens already
 * present (queue-then-send and recall-edit round trips must not duplicate).
 */
export function mergePinnedEntitiesText(input: string, tokens: string[]): string {
  const missing = tokens
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !input.includes(token));
  if (missing.length === 0) return input;
  const base = input.replace(/\s+$/, "");
  return base ? `${base}\n${missing.join("\n")}` : missing.join("\n");
}

export type ArtifactListItem = {
  type: ArtifactType;
  id?: string;
  sessionId?: string;
  title?: string;
  filename?: string;
  caption?: string;
  prompt?: string;
  kind?: string;
  projectId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  /** Site registry fields (present on site items for preview links). */
  siteId?: string;
  version?: number;
  status?: string;
  previewUrl?: string | null;
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
  caption: string;
  /** Chat context: scope resolves through the session. */
  sessionId?: string;
  /** Gallery context: scope is the image's own project (null = standalone). */
  projectId?: string | null;
}): Promise<{ id: string; caption: string }> {
  const body =
    input.sessionId !== undefined
      ? { caption: input.caption, sessionId: input.sessionId }
      : { caption: input.caption, projectId: input.projectId ?? null };
  const response = await apiFetch(
    `${API_BASE}/api/artifacts/images/${encodeURIComponent(input.imageId)}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(errorBody?.error ?? "Failed to update caption");
  }
  return (await response.json()) as { id: string; caption: string };
}

export type TaskSubtask = {
  id: string;
  title: string;
  done: boolean;
};

export type WorkspaceTask = {
  id: string;
  title: string;
  status: "inbox" | "doing" | "done";
  description: string | null;
  subtasks: TaskSubtask[];
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
  const items = Array.isArray(data.items) ? data.items : [];
  return items.map((task) => ({
    ...task,
    description: task.description ?? null,
    subtasks: Array.isArray(task.subtasks) ? task.subtasks : [],
  }));
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
  input: {
    sessionId: string;
    status?: WorkspaceTask["status"];
    title?: string;
    description?: string | null;
    addSubtasks?: string[];
    toggleSubtasks?: { id: string; done: boolean }[];
    removeSubtasks?: string[];
  },
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

export type ScopeSite = {
  siteId: string;
  sessionId: string;
  version: number;
  stableVersion: number | null;
  status: string;
  previewUrl: string | null;
  downloadUrl: string;
  updatedAt: string;
  /** Human label from the brief; null for legacy builds without one. */
  siteName?: string | null;
};

export type ChatSessionDetail = {
  sessionId: string;
  projectId: string | null;
  title: string | null;
};

export async function getChatSessionDetail(sessionId: string): Promise<ChatSessionDetail> {
  const response = await apiFetch(
    `${API_BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}`,
  );
  if (!response.ok) throw new Error("Session not found");
  return (await response.json()) as ChatSessionDetail;
}

export async function listScopeSites(sessionId: string): Promise<ScopeSite[]> {
  const params = new URLSearchParams({ sessionId });
  const response = await apiFetch(`${API_BASE}/api/sites?${params.toString()}`);
  if (!response.ok) throw new Error("Failed to load sites");
  const data = (await response.json()) as { sites?: ScopeSite[] };
  return Array.isArray(data.sites) ? data.sites : [];
}

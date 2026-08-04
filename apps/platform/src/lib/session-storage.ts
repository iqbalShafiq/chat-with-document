export const SESSION_STORAGE_KEY = "chat.sessionId";
export const LAST_STANDALONE_SESSION_KEY = "chat.lastStandaloneSessionId";
export const WORKSPACE_VIEW_MODE_KEY = "chat.viewMode";
export const WORKSPACE_PROJECT_ID_KEY = "chat.activeProjectId";
export const WORKSPACE_PROJECT_NAME_KEY = "chat.activeProjectName";

export type StoredWorkspaceViewMode =
  | "standalone"
  | "project-workspace"
  | "projects-index"
  | "documents-index";

export type StoredWorkspaceState = {
  viewMode: StoredWorkspaceViewMode;
  activeProjectId: string | null;
  activeProjectName: string | null;
};

export function createSessionId() {
  return crypto.randomUUID();
}

export function readStoredSessionId(): string | null {
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    if (stored && stored.trim().length > 0) return stored;
  } catch {
    // ignore storage access errors
  }
  return null;
}

export function persistSessionId(sessionId: string) {
  try {
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
  } catch {
    // ignore storage access errors
  }
}

export function clearStoredSessionId() {
  try {
    localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function readLastStandaloneSessionId(): string | null {
  try {
    const stored = localStorage.getItem(LAST_STANDALONE_SESSION_KEY);
    if (stored && stored.trim().length > 0) return stored;
  } catch {
    // ignore
  }
  return null;
}

export function persistLastStandaloneSessionId(sessionId: string) {
  try {
    localStorage.setItem(LAST_STANDALONE_SESSION_KEY, sessionId);
  } catch {
    // ignore
  }
}

function isViewMode(value: string | null): value is StoredWorkspaceViewMode {
  return (
    value === "standalone" ||
    value === "project-workspace" ||
    value === "projects-index" ||
    value === "documents-index"
  );
}

/** Restore workspace chrome after full page reload. */
export function readWorkspaceState(): StoredWorkspaceState {
  try {
    const rawMode = localStorage.getItem(WORKSPACE_VIEW_MODE_KEY);
    const viewMode: StoredWorkspaceViewMode = isViewMode(rawMode)
      ? rawMode
      : "standalone";
    const activeProjectId =
      localStorage.getItem(WORKSPACE_PROJECT_ID_KEY)?.trim() || null;
    const activeProjectName =
      localStorage.getItem(WORKSPACE_PROJECT_NAME_KEY)?.trim() || null;

    if (viewMode === "project-workspace" && !activeProjectId) {
      return {
        viewMode: "standalone",
        activeProjectId: null,
        activeProjectName: null,
      };
    }

    return {
      viewMode,
      activeProjectId:
        viewMode === "project-workspace" ? activeProjectId : null,
      activeProjectName:
        viewMode === "project-workspace" ? activeProjectName : null,
    };
  } catch {
    return {
      viewMode: "standalone",
      activeProjectId: null,
      activeProjectName: null,
    };
  }
}

export function persistWorkspaceState(state: StoredWorkspaceState) {
  try {
    localStorage.setItem(WORKSPACE_VIEW_MODE_KEY, state.viewMode);
    if (state.viewMode === "project-workspace" && state.activeProjectId) {
      localStorage.setItem(WORKSPACE_PROJECT_ID_KEY, state.activeProjectId);
      if (state.activeProjectName) {
        localStorage.setItem(
          WORKSPACE_PROJECT_NAME_KEY,
          state.activeProjectName,
        );
      } else {
        localStorage.removeItem(WORKSPACE_PROJECT_NAME_KEY);
      }
    } else {
      localStorage.removeItem(WORKSPACE_PROJECT_ID_KEY);
      localStorage.removeItem(WORKSPACE_PROJECT_NAME_KEY);
    }
  } catch {
    // ignore
  }
}

export function clearWorkspaceProjectState() {
  try {
    localStorage.setItem(WORKSPACE_VIEW_MODE_KEY, "standalone");
    localStorage.removeItem(WORKSPACE_PROJECT_ID_KEY);
    localStorage.removeItem(WORKSPACE_PROJECT_NAME_KEY);
  } catch {
    // ignore
  }
}

export const SESSION_STORAGE_KEY = "chat.sessionId";
export const LAST_STANDALONE_SESSION_KEY = "chat.lastStandaloneSessionId";
export const WORKSPACE_PROJECT_ID_KEY = "chat.activeProjectId";
export const WORKSPACE_PROJECT_NAME_KEY = "chat.activeProjectName";

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

export function clearLastStandaloneSessionId() {
  try {
    localStorage.removeItem(LAST_STANDALONE_SESSION_KEY);
  } catch {
    // ignore
  }
}

/** Drop client-invented session ids after login/register so Home opens a server draft. */
export function clearSessionOnAuth() {
  clearStoredSessionId();
  clearLastStandaloneSessionId();
  clearWorkspaceProjectState();
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

export function clearWorkspaceProjectState() {
  try {
    localStorage.removeItem(WORKSPACE_PROJECT_ID_KEY);
    localStorage.removeItem(WORKSPACE_PROJECT_NAME_KEY);
  } catch {
    // ignore
  }
}

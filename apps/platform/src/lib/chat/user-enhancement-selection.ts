export const SKILLS_SELECTION_KEY = "anreal.skills.selection";
export const MCP_SELECTION_KEY = "anreal.mcp.selection";

export const MAX_SKILL_SELECTION = 20;
export const MAX_MCP_SELECTION = 5;

function readStorage(key: string): string[] {
  try {
    if (typeof window === "undefined" || !window.localStorage) return [];
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    );
  } catch {
    return [];
  }
}

/** Last per-chat selection for a key; corrupt storage reads as []. */
export function loadIdSelection(key: string): string[] {
  return readStorage(key);
}

export function saveIdSelection(key: string, ids: string[]): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    const cap = key === MCP_SELECTION_KEY ? MAX_MCP_SELECTION : MAX_SKILL_SELECTION;
    const clean = ids
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
      .slice(0, cap);
    window.localStorage.setItem(key, JSON.stringify(clean));
  } catch {
    // Private mode / quota — selection simply doesn't persist.
  }
}

/** Keep request order, drop ids missing from the catalog. */
export function intersectWithCatalog(ids: string[], catalogIds: string[]): string[] {
  const catalog = new Set(catalogIds);
  return ids.filter((id) => catalog.has(id));
}

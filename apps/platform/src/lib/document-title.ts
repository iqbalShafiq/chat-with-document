const APP_NAME = "Anreal";

/** Keep tab titles and bookmarks meaningful: "<title> – Anreal". */
export function formatWorkspaceTitle(title: string | null): string {
  const trimmed = title?.trim();
  return trimmed ? `${trimmed} – ${APP_NAME}` : APP_NAME;
}

export function applyWorkspaceTitle(title: string | null): void {
  if (typeof document === "undefined") return;
  document.title = formatWorkspaceTitle(title);
}

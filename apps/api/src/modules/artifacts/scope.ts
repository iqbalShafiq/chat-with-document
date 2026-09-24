export function artifactWhere(userId: string, sessionProjectId: string | null): {
  userId: string;
  projectId: string | null;
} {
  return sessionProjectId
    ? { userId, projectId: sessionProjectId }
    : { userId, projectId: null };
}

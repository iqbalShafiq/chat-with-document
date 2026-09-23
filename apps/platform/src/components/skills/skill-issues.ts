export type FieldErrors = {
  name?: string;
  description?: string;
  bodyMd?: string;
  form?: string;
};

/** Map server issue paths onto editor fields, unknown paths to the form. */
export function issuesToFieldErrors(
  issues: { path: string; message: string }[],
): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of issues) {
    if (issue.path === "name" || issue.path === "description" || issue.path === "bodyMd") {
      out[issue.path] ??= issue.message;
    } else {
      out.form ??= issue.message;
    }
  }
  if (Object.keys(out).length === 0) out.form = "Could not save";
  return out;
}

/** Read issues attached by the api client onto thrown save errors. */
export function issuesFromError(error: unknown): { path: string; message: string }[] {
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (issue): issue is { path: string; message: string } =>
      typeof issue === "object" &&
      issue !== null &&
      typeof (issue as { path?: unknown }).path === "string" &&
      typeof (issue as { message?: unknown }).message === "string",
  );
}

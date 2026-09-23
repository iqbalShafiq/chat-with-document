export const MAX_USER_MCP_SERVERS = 5;
export const MCP_URL_MAX = 512;
export const MCP_NAME_MAX = 64;

export type McpAuthType = "none" | "bearer";

export type McpIssue = { path: "name" | "url" | "authType"; message: string };

export class McpInputError extends Error {
  readonly issues: McpIssue[];
  constructor(issues: McpIssue[]) {
    super(issues[0]?.message ?? "Invalid MCP server");
    this.name = "McpInputError";
    this.issues = issues;
  }
}

const BLOCKED_HOST_RE =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|\[?::1\]?)$/i;

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) {
    return false;
  }
  const [a, b] = parts.map(Number);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && (b as number) >= 16 && (b as number) <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Returns null when valid, otherwise a user-facing reason. Pure — no network. */
export function validateMcpUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.length === 0 || url.length > MCP_URL_MAX) {
    return "URL must be 1-512 characters";
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "URL is not a valid absolute URL";
  }
  if (parsed.protocol !== "https:") {
    return "MCP URL must use public https (http and private hosts are blocked)";
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOST_RE.test(host) || isPrivateIpv4(host)) {
    return "MCP URL must be a public host (local and private addresses are blocked)";
  }
  return null;
}

export type McpServerInput = {
  name: string;
  url: string;
  authType: McpAuthType;
};

export function validateMcpServerInput(input: McpServerInput):
  | { ok: true; value: McpServerInput }
  | { ok: false; issues: McpIssue[] } {
  const issues: McpIssue[] = [];
  const name = input.name.trim();
  if (name.length === 0 || name.length > MCP_NAME_MAX) {
    issues.push({ path: "name", message: "Name must be 1-64 characters" });
  }
  if (input.authType !== "none" && input.authType !== "bearer") {
    issues.push({ path: "authType", message: 'Auth must be "none" or "bearer"' });
  }
  const urlError = validateMcpUrl(input.url);
  if (urlError) issues.push({ path: "url", message: urlError });
  if (issues.length > 0) return { ok: false as const, issues };
  return {
    ok: true as const,
    value: { name, url: input.url.trim(), authType: input.authType },
  };
}

export const MAX_REVIEW_TOOLS = 64;
export const MCP_TOOL_NAME_MAX = 128;
// Matches the frozen recipe surface (staticToolDefinitionSchema description
// bound): the server must never reject a definition the recipe accepts.
export const MCP_TOOL_DESCRIPTION_MAX = 16000;

export type McpReviewTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

function validateReviewTools(
  allowedTools: unknown,
  tools: unknown,
): { allowedTools: string[]; tools: McpReviewTool[] } {
  if (!Array.isArray(allowedTools) || allowedTools.length > MAX_REVIEW_TOOLS) {
    throw new McpInputError([{ path: "name", message: "Reviewed tools are invalid" }]);
  }
  for (const name of allowedTools) {
    if (typeof name !== "string" || !name.trim() || name.length > MCP_TOOL_NAME_MAX) {
      throw new McpInputError([{ path: "name", message: "Tool name must be 1-128 characters" }]);
    }
  }
  if (!Array.isArray(tools) || tools.length > MAX_REVIEW_TOOLS) {
    throw new McpInputError([{ path: "name", message: "Reviewed tools are invalid" }]);
  }
  const clean: McpReviewTool[] = [];
  for (const entry of tools) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new McpInputError([{ path: "name", message: "Reviewed tools are invalid" }]);
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim() || record.name.length > MCP_TOOL_NAME_MAX) {
      throw new McpInputError([{ path: "name", message: "Tool name must be 1-128 characters" }]);
    }
    if (typeof record.description !== "string" || record.description.length > MCP_TOOL_DESCRIPTION_MAX) {
      throw new McpInputError([{ path: "name", message: `Tool description must be at most ${MCP_TOOL_DESCRIPTION_MAX} characters` }]);
    }
    const parameters =
      typeof record.parameters === "object" && record.parameters !== null && !Array.isArray(record.parameters)
        ? (record.parameters as Record<string, unknown>)
        : {};
    clean.push({ name: record.name, description: record.description, parameters });
  }
  return { allowedTools: allowedTools as string[], tools: clean };
}

/** Store the reviewed tool subset from a successful test-connection. */
export async function setMcpReview(
  db: McpDb,
  userId: string,
  id: string,
  review: { allowedTools: unknown; tools: unknown },
) {
  const existing = await db.userMcpServer.findFirst({ where: { id, userId } });
  if (!existing) throw new McpInputError(NOT_FOUND);
  const validated = validateReviewTools(review.allowedTools, review.tools);
  return db.userMcpServer.update({
    where: { id },
    data: {
      allowedToolsJson: validated.allowedTools,
      toolsJson: validated.tools,
      status: "ok",
      lastError: null,
    },
  });
}

export type McpDb = {
  userMcpServer: {
    findMany(args: unknown): Promise<unknown[]>;
    findFirst(args: unknown): Promise<unknown | null>;
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    update(args: {
      where: { id: string };
      data: Record<string, unknown>;
    }): Promise<unknown>;
    delete(args: { where: { id: string } }): Promise<unknown>;
    count(args: unknown): Promise<number>;
  };
};

const NOT_FOUND: McpIssue[] = [{ path: "name", message: "MCP server not found" }];

/** List strips server-side credentials — the browser never sees them. */
export async function listMcpServers(db: McpDb, userId: string) {
  const rows = (await db.userMcpServer.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  })) as Record<string, unknown>[];
  return rows.map(stripCredentials);
}

function stripCredentials(row: Record<string, unknown>) {
  const { credentialsRef: _dropped, ...rest } = row;
  return rest;
}

export async function createMcpServer(
  db: McpDb,
  userId: string,
  input: McpServerInput,
) {
  const validated = validateMcpServerInput(input);
  if (!validated.ok) throw new McpInputError(validated.issues);
  const count = await db.userMcpServer.count({ where: { userId } });
  if (count >= MAX_USER_MCP_SERVERS) {
    throw new McpInputError([
      { path: "name", message: `MCP server limit reached (${MAX_USER_MCP_SERVERS})` },
    ]);
  }
  return db.userMcpServer.create({
    data: {
      userId,
      ...validated.value,
      credentialsRef: "",
      allowedToolsJson: [],
      toolsJson: [],
      isEnabled: true,
      status: "untested",
    },
  });
}

export async function updateMcpServer(
  db: McpDb,
  userId: string,
  id: string,
  input: McpServerInput,
) {
  const existing = await db.userMcpServer.findFirst({ where: { id, userId } });
  if (!existing) throw new McpInputError(NOT_FOUND);
  const validated = validateMcpServerInput(input);
  if (!validated.ok) throw new McpInputError(validated.issues);
  return db.userMcpServer.update({
    where: { id },
    data: {
      ...validated.value,
      status: "untested",
      lastError: null,
    },
  });
}

export async function setMcpCredentials(
  db: McpDb,
  userId: string,
  id: string,
  credentialsRef: string,
) {
  const existing = await db.userMcpServer.findFirst({ where: { id, userId } });
  if (!existing) throw new McpInputError(NOT_FOUND);
  return db.userMcpServer.update({ where: { id }, data: { credentialsRef } });
}

export async function deleteMcpServer(db: McpDb, userId: string, id: string) {
  const existing = await db.userMcpServer.findFirst({ where: { id, userId } });
  if (!existing) throw new McpInputError(NOT_FOUND);
  return db.userMcpServer.delete({ where: { id } });
}

export async function setMcpServerEnabled(
  db: McpDb,
  userId: string,
  id: string,
  isEnabled: boolean,
) {
  const existing = await db.userMcpServer.findFirst({ where: { id, userId } });
  if (!existing) throw new McpInputError(NOT_FOUND);
  return db.userMcpServer.update({ where: { id }, data: { isEnabled } });
}

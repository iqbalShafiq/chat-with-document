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
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|\[?::1\]?|\[?::\]?|\[?::ffff:[^\]]*\]?)$/i;

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

/** Dotted quads with out-of-range octets never resolve safely — reject. */
function isMalformedNumericHost(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) && !isStrictIpv4(host);
}

function isStrictIpv4(host: string): boolean {
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
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
  const host = parsed.hostname.toLowerCase().replace(/\.*$/, "");
  if (
    host === "0.0.0.0" ||
    BLOCKED_HOST_RE.test(host) ||
    isPrivateIpv4(host) ||
    isMalformedNumericHost(host)
  ) {
    return "MCP URL must use public https — local and private addresses are blocked";
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

import { Buffer } from "node:buffer";
import { decryptToken, encryptToken } from "./credentials.js";

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
  const known = new Set(clean.map((tool) => tool.name));
  for (const name of allowedTools as string[]) {
    if (!known.has(name)) {
      throw new McpInputError([
        { path: "name", message: `Allowed tool "${name}" is missing from the reviewed definitions` },
      ]);
    }
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

export const MAX_MCP_HEADERS = 16;
export const MCP_HEADER_NAME_MAX = 128;
export const MCP_HEADER_VALUE_MAX = 2048;

export type McpHeader = { name: string; value: string };

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;

function validateMcpHeaders(headers: unknown): McpHeader[] {
  if (!Array.isArray(headers) || headers.length > MAX_MCP_HEADERS) {
    throw new McpInputError([{ path: "name", message: "Custom headers are invalid" }]);
  }
  const seen = new Set<string>();
  const clean: McpHeader[] = [];
  for (const entry of headers) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new McpInputError([{ path: "name", message: "Custom headers are invalid" }]);
    }
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    const value = typeof record.value === "string" ? record.value : "";
    if (!HEADER_NAME_RE.test(name) || name.length > MCP_HEADER_NAME_MAX) {
      throw new McpInputError([{ path: "name", message: "Header name must be a valid token (max 128 chars)" }]);
    }
    if (name.toLowerCase() === "authorization") {
      throw new McpInputError([
        { path: "name", message: "Use the auth type for authorization, not a custom header" },
      ]);
    }
    if (!value || value.length > MCP_HEADER_VALUE_MAX) {
      throw new McpInputError([{ path: "name", message: "Header value must be 1-2048 characters" }]);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      throw new McpInputError([{ path: "name", message: `Duplicate header "${name}"` }]);
    }
    seen.add(key);
    clean.push({ name, value });
  }
  return clean;
}

/** Store custom headers encrypted (values may hold secrets like API keys). */
export async function setMcpHeaders(
  db: McpDb,
  userId: string,
  id: string,
  headers: unknown,
) {
  const existing = await db.userMcpServer.findFirst({ where: { id, userId } });
  if (!existing) throw new McpInputError(NOT_FOUND);
  const validated = validateMcpHeaders(headers);
  return db.userMcpServer.update({
    where: { id },
    data: { headersRef: encryptToken(JSON.stringify(validated)) },
  });
}

/** Read and decrypt stored custom headers ([] when none were saved). */
export async function getMcpHeaders(
  db: McpDb,
  userId: string,
  id: string,
): Promise<McpHeader[]> {
  const existing = (await db.userMcpServer.findFirst({
    where: { id, userId },
  })) as { headersRef?: unknown } | null;
  if (!existing || typeof existing.headersRef !== "string" || !existing.headersRef) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(decryptToken(existing.headersRef));
    return validateMcpHeaders(parsed);
  } catch {
    return [];
  }
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
  return rows.map((row) => {
    const { credentialsRef: _c, headersRef: _h, ...rest } = row;
    return {
      ...rest,
      hasCredentials:
        typeof _c === "string" && (_c as string).length > 0,
      hasHeaders: typeof _h === "string" && (_h as string).length > 0,
    };
  });
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
  // Encrypt at the single write choke point; raw tokens never reach the DB.
  return db.userMcpServer.update({
    where: { id },
    data: { credentialsRef: encryptToken(credentialsRef) },
  });
}

/** Read and decrypt the stored credential (null when none was saved). */
export async function getMcpCredentials(
  db: McpDb,
  userId: string,
  id: string,
): Promise<string | null> {
  const existing = (await db.userMcpServer.findFirst({
    where: { id, userId },
  })) as { credentialsRef?: unknown } | null;
  if (!existing || typeof existing.credentialsRef !== "string" || !existing.credentialsRef) {
    return null;
  }
  const ref = existing.credentialsRef;
  if (!looksLikeEnvelope(ref)) {
    // Legacy plaintext row (pre-encryption): use once and transparently
    // upgrade to an encrypted envelope so the next read is clean.
    await db.userMcpServer.update({
      where: { id },
      data: { credentialsRef: encryptToken(ref) },
    });
    return ref;
  }
  return decryptToken(ref);
}

function looksLikeEnvelope(ref: string): boolean {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(ref, "base64").toString("utf8"));
    return (
      typeof parsed === "object" && parsed !== null && (parsed as { v?: unknown }).v === 1
    );
  } catch {
    return false;
  }
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

export const MAX_SKILL_IDS = 20;
export const MAX_MCP_SERVER_IDS = 5;

export type UserSkillSnapshot = {
  id: string;
  name: string;
  description: string;
  bodyMd: string;
};

export type UserMcpToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type UserMcpSnapshot = {
  id: string;
  name: string;
  url: string;
  allowedTools: string[];
  toolDefinitions: UserMcpToolDefinition[];
};

export type UserEnhancementDb = {
  userSkill: {
    findMany(args: unknown): Promise<unknown[]>;
  };
  userMcpServer: {
    findMany(args: unknown): Promise<unknown[]>;
  };
};

export type UserEnhancementSelection = {
  skillIds: string[];
  mcpServerIds: string[];
};

export type UserEnhancementCountsDb = {
  userSkill: {
    count(args: unknown): Promise<number>;
  };
  userMcpServer: {
    count(args: unknown): Promise<number>;
  };
};

/** Counts only — never urls, bodies, or credentials. */
export async function getUserEnhancementCounts(
  db: UserEnhancementCountsDb,
  userId: string,
): Promise<{ userSkillsCount: number; userMcpCount: number }> {
  const [userSkillsCount, userMcpCount] = await Promise.all([
    db.userSkill.count({ where: { userId } }),
    db.userMcpServer.count({ where: { userId } }),
  ]);
  return { userSkillsCount, userMcpCount };
}

export type UserEnhancementResolution = {
  userSkills: UserSkillSnapshot[];
  userMcp: UserMcpSnapshot[];
  droppedSkillIds: string[];
  droppedMcpServerIds: string[];
};

function uniqueCapped(ids: string[], cap: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= cap) break;
  }
  return out;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function toolDefinitions(value: unknown): UserMcpToolDefinition[] {
  if (!Array.isArray(value)) return [];
  const out: UserMcpToolDefinition[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || !record.name.trim()) continue;
    const parameters =
      typeof record.parameters === "object" &&
      record.parameters !== null &&
      !Array.isArray(record.parameters)
        ? (record.parameters as Record<string, unknown>)
        : {};
    out.push({
      name: record.name,
      description: typeof record.description === "string" ? record.description : "",
      parameters,
    });
  }
  return out;
}

type SkillRow = {
  id: string;
  name: string;
  description: string;
  bodyMd: string;
};

type McpRow = {
  id: string;
  name: string;
  url: string;
  allowedToolsJson: unknown;
  toolsJson: unknown;
};

/**
 * Resolve a per-chat selection into frozen recipe snapshots. Only rows the
 * user owns that are still enabled+active survive; everything else is
 * reported in dropped* so the caller can refresh the client. Never throws
 * for unknown ids — the run proceeds with the remainder (fail-open
 * selection, fail-closed execution happens in the worker).
 */
export async function resolveUserEnhancements(
  db: UserEnhancementDb,
  userId: string,
  selection: UserEnhancementSelection,
): Promise<UserEnhancementResolution> {
  const wantedSkills = uniqueCapped(selection.skillIds, MAX_SKILL_IDS);
  const wantedMcp = uniqueCapped(selection.mcpServerIds, MAX_MCP_SERVER_IDS);

  const skillRows = (await db.userSkill.findMany({
    where: { userId, isEnabled: true, status: "active" },
  })) as SkillRow[];
  const mcpRows = (await db.userMcpServer.findMany({
    where: { userId, isEnabled: true, status: { not: "error" } },
  })) as McpRow[];

  const skillsById = new Map(skillRows.map((row) => [row.id, row]));
  const mcpById = new Map(mcpRows.map((row) => [row.id, row]));

  const userSkills: UserSkillSnapshot[] = [];
  const droppedSkillIds: string[] = [];
  for (const id of wantedSkills) {
    const row = skillsById.get(id);
    if (!row) {
      droppedSkillIds.push(id);
      continue;
    }
    userSkills.push({
      id: row.id,
      name: row.name,
      description: row.description,
      bodyMd: row.bodyMd,
    });
  }

  const userMcp: UserMcpSnapshot[] = [];
  const droppedMcpServerIds: string[] = [];
  for (const id of wantedMcp) {
    const row = mcpById.get(id);
    if (!row) {
      droppedMcpServerIds.push(id);
      continue;
    }
    const allowedTools = stringArray(row.allowedToolsJson);
    const known = toolDefinitions(row.toolsJson);
    const allowed = new Set(allowedTools);
    userMcp.push({
      id: row.id,
      name: row.name,
      url: row.url,
      allowedTools,
      toolDefinitions:
        allowed.size === 0
          ? known
          : known.filter((tool) => allowed.has(tool.name)),
    });
  }

  return { userSkills, userMcp, droppedSkillIds, droppedMcpServerIds };
}

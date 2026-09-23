export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_BODY_MAX = 16000;
export const MAX_ACTIVE_SKILLS = 20;

export type SkillIssuePath = "name" | "description" | "bodyMd";
export type SkillIssue = { path: SkillIssuePath; message: string };

export class SkillInputError extends Error {
  readonly issues: SkillIssue[];
  constructor(issues: SkillIssue[]) {
    super(issues[0]?.message ?? "Invalid skill");
    this.name = "SkillInputError";
    this.issues = issues;
  }
}

export type SkillInput = { name: string; description: string; bodyMd: string };

export function validateSkillInput(input: SkillInput):
  | { ok: true; value: SkillInput }
  | { ok: false; issues: SkillIssue[] } {
  const issues: SkillIssue[] = [];
  const name = input.name.trim();
  if (!SKILL_NAME_RE.test(name) || name.length > SKILL_NAME_MAX) {
    issues.push({
      path: "name",
      message:
        "Name must be lowercase letters, numbers, and hyphens (max 64), e.g. release-notes",
    });
  }
  const description = input.description.trim();
  if (description.length === 0 || description.length > SKILL_DESCRIPTION_MAX) {
    issues.push({
      path: "description",
      message:
        "Description must be 1-1024 characters and say when to use the skill",
    });
  }
  const bodyMd = input.bodyMd.trim();
  if (bodyMd.length === 0 || bodyMd.length > SKILL_BODY_MAX) {
    issues.push({
      path: "bodyMd",
      message: "SKILL.md must be 1-16000 characters",
    });
  } else {
    const frontmatter = extractFrontmatter(bodyMd);
    if (!frontmatter) {
      issues.push({
        path: "bodyMd",
        message: "SKILL.md must start with a YAML frontmatter block between --- lines",
      });
    } else {
      const fmName = stripYamlQuotes(frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim());
      const fmDescription = stripYamlQuotes(
        frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim(),
      );
      if (fmName !== name) {
        issues.push({
          path: "bodyMd",
          message: `Frontmatter name: "${fmName ?? "missing"}" must equal the skill name ("${name}")`,
        });
      }
      if (fmDescription !== description) {
        issues.push({
          path: "bodyMd",
          message: "Frontmatter description: must equal the description field",
        });
      }
    }
  }
  if (issues.length > 0) return { ok: false as const, issues };
  return { ok: true as const, value: { name, description, bodyMd } };
}

/** Strip one layer of YAML single/double quotes from a scalar. */
function stripYamlQuotes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function extractFrontmatter(bodyMd: string): string | null {
  const lines = bodyMd.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex(
    (line, index) => index > 0 && line.trim() === "---",
  );
  if (end < 0) return null;
  return lines.slice(1, end).join("\n");
}

export type SkillsDb = {
  userSkill: {
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

export async function listSkills(db: SkillsDb, userId: string) {
  return db.userSkill.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
}

export async function createSkill(
  db: SkillsDb,
  userId: string,
  input: SkillInput,
) {
  const validated = validateSkillInput(input);
  if (!validated.ok) throw new SkillInputError(validated.issues);
  const activeCount = await db.userSkill.count({
    where: { userId, isEnabled: true, status: "active" },
  });
  if (activeCount >= MAX_ACTIVE_SKILLS) {
    throw new SkillInputError([
      { path: "name", message: `Skill limit reached (${MAX_ACTIVE_SKILLS} active)` },
    ]);
  }
  return db.userSkill.create({
    data: {
      userId,
      ...validated.value,
      isEnabled: true,
      status: "active",
      version: 1,
    },
  });
}

export async function updateSkill(
  db: SkillsDb,
  userId: string,
  id: string,
  input: SkillInput,
) {
  const existing = await db.userSkill.findFirst({ where: { id, userId } });
  if (!existing) throw new SkillInputError([{ path: "name", message: "Skill not found" }]);
  const validated = validateSkillInput(input);
  if (!validated.ok) throw new SkillInputError(validated.issues);
  const current = existing as { version?: unknown };
  const version = typeof current.version === "number" ? current.version + 1 : 1;
  return db.userSkill.update({
    where: { id },
    data: { ...validated.value, status: "active", issuesJson: null, version },
  });
}

export async function deleteSkill(db: SkillsDb, userId: string, id: string) {
  const existing = await db.userSkill.findFirst({ where: { id, userId } });
  if (!existing) throw new SkillInputError([{ path: "name", message: "Skill not found" }]);
  return db.userSkill.delete({ where: { id } });
}

export async function setSkillEnabled(
  db: SkillsDb,
  userId: string,
  id: string,
  isEnabled: boolean,
) {
  const existing = (await db.userSkill.findFirst({ where: { id, userId } })) as {
    status?: unknown;
  } | null;
  if (!existing) throw new SkillInputError([{ path: "name", message: "Skill not found" }]);
  if (isEnabled) {
    if (existing.status === "draft") {
      throw new SkillInputError([
        { path: "name", message: "Review the skill in the Skills modal before enabling it" },
      ]);
    }
    if (existing.status !== "active") {
      throw new SkillInputError([
        { path: "name", message: "Fix the skill before enabling it" },
      ]);
    }
    const activeCount = await db.userSkill.count({
      where: { userId, isEnabled: true, status: "active", id: { not: id } },
    });
    if (activeCount >= MAX_ACTIVE_SKILLS) {
      throw new SkillInputError([
        { path: "name", message: `Skill limit reached (${MAX_ACTIVE_SKILLS} active)` },
      ]);
    }
  }
  return db.userSkill.update({ where: { id }, data: { isEnabled } });
}

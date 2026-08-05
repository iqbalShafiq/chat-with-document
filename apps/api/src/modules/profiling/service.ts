import {
  extractTextFromMessageJson,
  createCompletionModel,
  DEFAULT_COMPLETION_MODEL,
  EMPTY_PROFILE_SECTIONS,
  parseCompletionModel,
  summarizeProfileDelta,
  type ExplicitFact,
  type ProfileData,
  type ProfileDeltaMessage,
  type ProfileScope,
  type ProfileSectionKey,
  type ProfileSections,
} from "@assingment/agent";
import type { CompletionModel } from "@anvia/core";
import { prisma } from "../../utils/prisma.js";
import type { Prisma } from "../../generated/prisma/client.js";

export type ProfileConfig = {
  enabled: boolean;
  delayMs: number;
  concurrency: number;
  model: CompletionModel;
};

export function profileConfig(): ProfileConfig {
  const enabled = process.env.PROFILE_ENABLED !== "false";
  const delayMinutes = Number(process.env.PROFILE_REFRESH_DELAY_MINUTES ?? "15");
  const concurrency = Number(process.env.PROFILE_WORKER_CONCURRENCY ?? "3");
  const modelId = parseCompletionModel(process.env.PROFILE_SUMMARY_MODEL);
  return {
    enabled,
    delayMs:
      Number.isFinite(delayMinutes) && delayMinutes > 0
        ? Math.round(delayMinutes * 60_000)
        : 15 * 60_000,
    concurrency:
      Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 3,
    model: createCompletionModel(modelId ?? DEFAULT_COMPLETION_MODEL),
  };
}

function profileWhere(scope: ProfileScope): { userId: string; projectId?: string } {
  return scope.kind === "project"
    ? { userId: scope.userId, projectId: scope.projectId }
    : { userId: scope.userId };
}

function toProfileData(row: {
  sections: Prisma.JsonValue;
  explicitFacts: Prisma.JsonValue;
}): ProfileData {
  const sections = (row.sections ?? {}) as Record<string, unknown>;
  const facts = (row.explicitFacts ?? []) as unknown[];
  return {
    sections: {
      facts: Array.isArray(sections.facts) ? (sections.facts as string[]) : [],
      preferences: Array.isArray(sections.preferences)
        ? (sections.preferences as string[])
        : [],
      interests: Array.isArray(sections.interests)
        ? (sections.interests as string[])
        : [],
      expertise: Array.isArray(sections.expertise)
        ? (sections.expertise as string[])
        : [],
      goals: Array.isArray(sections.goals) ? (sections.goals as string[]) : [],
    },
    explicitFacts: facts
      .filter((fact): fact is Record<string, unknown> => typeof fact === "object" && fact !== null)
      .map((fact) => ({
        section: typeof fact.section === "string" ? (fact.section as ProfileSectionKey) : null,
        fact: typeof fact.fact === "string" ? fact.fact : "",
        createdAt: typeof fact.createdAt === "string" ? fact.createdAt : "",
      }))
      .filter((fact) => fact.fact.length > 0),
  };
}

export async function loadProfileData(
  scope: ProfileScope,
): Promise<(ProfileData & { lastProcessedAt: Date }) | null> {
  if (scope.kind === "user") {
    const row = await prisma.userProfile.findUnique({
      where: { userId: scope.userId },
      select: { sections: true, explicitFacts: true, lastProcessedAt: true },
    });
    return row ? { ...toProfileData(row), lastProcessedAt: row.lastProcessedAt } : null;
  }

  const row = await prisma.projectProfile.findUnique({
    where: { userId_projectId: { userId: scope.userId, projectId: scope.projectId } },
    select: { sections: true, explicitFacts: true, lastProcessedAt: true },
  });
  return row ? { ...toProfileData(row), lastProcessedAt: row.lastProcessedAt } : null;
}

export async function loadProfileDelta(
  scope: ProfileScope,
  since: Date,
): Promise<ProfileDeltaMessage[]> {
  const chatSessions = await prisma.chatSession.findMany({
    where: profileWhere(scope),
    select: { id: true },
  });
  if (chatSessions.length === 0) return [];

  const rows = await prisma.agentMemoryMessage.findMany({
    where: {
      role: "user",
      createdAt: { gt: since },
      memorySession: { sessionId: { in: chatSessions.map((session) => session.id) } },
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { createdAt: true, message: true },
    take: 2000,
  });

  const delta: ProfileDeltaMessage[] = [];
  for (const row of rows) {
    const text = extractTextFromMessageJson(row.message).trim();
    if (!text) continue;
    delta.push({ createdAt: row.createdAt.toISOString(), text });
  }
  return delta;
}

export async function saveProfileResult(
  scope: ProfileScope,
  input: { sections: ProfileSections; watermark: Date },
): Promise<void> {
  const data = {
    sections: input.sections as unknown as Prisma.InputJsonValue,
    lastProcessedAt: input.watermark,
  };
  if (scope.kind === "user") {
    await prisma.userProfile.upsert({
      where: { userId: scope.userId },
      create: { userId: scope.userId, ...data },
      update: data,
    });
  } else {
    await prisma.projectProfile.upsert({
      where: {
        userId_projectId: { userId: scope.userId, projectId: scope.projectId },
      },
      create: { userId: scope.userId, projectId: scope.projectId, ...data },
      update: data,
    });
  }
}

export async function appendExplicitFact(
  scope: ProfileScope,
  input: { section: ProfileSectionKey | null; fact: string },
): Promise<void> {
  const existing = await loadProfileData(scope);
  const facts: ExplicitFact[] = existing?.explicitFacts ?? [];
  facts.push({
    section: input.section,
    fact: input.fact,
    createdAt: new Date().toISOString(),
  });
  const capped = facts.slice(-100);

  const data = { explicitFacts: capped as unknown as Prisma.InputJsonValue };
  if (scope.kind === "user") {
    await prisma.userProfile.upsert({
      where: { userId: scope.userId },
      create: { userId: scope.userId, sections: {} as Prisma.InputJsonValue, ...data },
      update: data,
    });
  } else {
    await prisma.projectProfile.upsert({
      where: {
        userId_projectId: { userId: scope.userId, projectId: scope.projectId },
      },
      create: {
        userId: scope.userId,
        projectId: scope.projectId,
        sections: {} as Prisma.InputJsonValue,
        ...data,
      },
      update: data,
    });
  }
}

export async function advanceProfileWatermark(
  scope: ProfileScope,
  at: Date,
): Promise<void> {
  const data = { lastProcessedAt: at };
  if (scope.kind === "user") {
    await prisma.userProfile.upsert({
      where: { userId: scope.userId },
      create: { userId: scope.userId, sections: {} as Prisma.InputJsonValue, ...data },
      update: data,
    });
  } else {
    await prisma.projectProfile.upsert({
      where: {
        userId_projectId: { userId: scope.userId, projectId: scope.projectId },
      },
      create: {
        userId: scope.userId,
        projectId: scope.projectId,
        sections: {} as Prisma.InputJsonValue,
        ...data,
      },
      update: data,
    });
  }
}

export async function resetProfile(scope: ProfileScope): Promise<void> {
  const data = {
    sections: EMPTY_PROFILE_SECTIONS as unknown as Prisma.InputJsonValue,
    explicitFacts: [] as unknown as Prisma.InputJsonValue,
    lastProcessedAt: new Date(),
  };
  if (scope.kind === "user") {
    await prisma.userProfile.upsert({
      where: { userId: scope.userId },
      create: { userId: scope.userId, ...data },
      update: data,
    });
  } else {
    await prisma.projectProfile.upsert({
      where: {
        userId_projectId: { userId: scope.userId, projectId: scope.projectId },
      },
      create: { userId: scope.userId, projectId: scope.projectId, ...data },
      update: data,
    });
  }
}

/**
 * Shared core for the worker and the remember tool: load existing profile,
 * read the delta since the watermark, summarize incrementally, save, advance
 * the watermark. Returns 0 processed when there is nothing new.
 */
export async function summarizeProfileForScope(scope: ProfileScope): Promise<{
  processed: number;
  watermark: Date | null;
}> {
  const existing = await loadProfileData(scope);
  const since = existing?.lastProcessedAt ?? new Date(0);
  const delta = await loadProfileDelta(scope, since);
  if (delta.length === 0) return { processed: 0, watermark: existing?.lastProcessedAt ?? null };

  const { sections } = await summarizeProfileDelta({
    model: profileConfig().model,
    existing: existing ?? { sections: EMPTY_PROFILE_SECTIONS, explicitFacts: [] },
    delta,
  });

  const watermark = new Date(delta[delta.length - 1]!.createdAt);
  await saveProfileResult(scope, { sections, watermark });
  return { processed: delta.length, watermark };
}

export type ProfileDto = {
  sections: ProfileSections;
  explicitFacts: ExplicitFact[];
  updatedAt: string;
};

export async function getProfilingSettingsPayload(userId: string): Promise<{
  user: ProfileDto | null;
  projects: Array<{ id: string; name: string; profile: ProfileDto | null }>;
}> {
  const [userRow, projectRows, projectProfileRows] = await Promise.all([
    prisma.userProfile.findUnique({
      where: { userId },
      select: { sections: true, explicitFacts: true, updatedAt: true },
    }),
    prisma.project.findMany({
      where: { userId },
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.projectProfile.findMany({
      where: { userId },
      select: { projectId: true, sections: true, explicitFacts: true, updatedAt: true },
    }),
  ]);

  const byProject = new Map(projectProfileRows.map((row) => [row.projectId, row]));
  return {
    user: userRow
      ? {
          ...toProfileData(userRow),
          updatedAt: userRow.updatedAt.toISOString(),
        }
      : null,
    projects: projectRows.map((project) => {
      const row = byProject.get(project.id);
      return {
        id: project.id,
        name: project.name,
        profile: row
          ? {
              ...toProfileData(row),
              updatedAt: row.updatedAt.toISOString(),
            }
          : null,
      };
    }),
  };
}

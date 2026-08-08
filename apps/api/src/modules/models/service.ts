import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../utils/prisma.js";

type Decimal = Prisma.Decimal;

export type ModelInfo = {
  modelId: string;
  label: string;
  /** Full display name, e.g. "GPT 5.6 Luna" (falls back to label). */
  name: string;
  hint: string | null;
  description: string | null;
  iconSvg: string;
  provider: { slug: string; name: string };
  contextWindowTokens: number;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  prices: {
    input: number | null;
    cachedInput: number | null;
    output: number | null;
    cacheWriteMultiplier: number | null;
    longPromptThresholdTokens: number | null;
    longPromptInputMultiplier: number | null;
    longPromptOutputMultiplier: number | null;
  };
  reasoningEfforts: string[];
  sortOrder: number;
};

export type ReasoningEffortInfo = {
  key: string;
  label: string;
  description: string | null;
  sortOrder: number;
};

function toNumber(value: Decimal | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toModelInfo(row: {
  modelId: string;
  label: string;
  name: string;
  hint: string | null;
  description: string | null;
  iconSvg: string;
  contextWindowTokens: number;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  inputPricePerMTokens: Decimal | null;
  cachedInputPricePerMTokens: Decimal | null;
  outputPricePerMTokens: Decimal | null;
  cacheWriteMultiplier: Decimal | null;
  longPromptThresholdTokens: number | null;
  longPromptInputMultiplier: Decimal | null;
  longPromptOutputMultiplier: Decimal | null;
  sortOrder: number;
  provider: { slug: string; name: string };
  reasoningEfforts: { effort: { key: string } }[];
}): ModelInfo {
  return {
    modelId: row.modelId,
    label: row.label,
    name: row.name || row.label,
    hint: row.hint,
    description: row.description,
    iconSvg: row.iconSvg,
    provider: row.provider,
    contextWindowTokens: row.contextWindowTokens,
    maxInputTokens: row.maxInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    prices: {
      input: toNumber(row.inputPricePerMTokens),
      cachedInput: toNumber(row.cachedInputPricePerMTokens),
      output: toNumber(row.outputPricePerMTokens),
      cacheWriteMultiplier: toNumber(row.cacheWriteMultiplier),
      longPromptThresholdTokens: row.longPromptThresholdTokens,
      longPromptInputMultiplier: toNumber(row.longPromptInputMultiplier),
      longPromptOutputMultiplier: toNumber(row.longPromptOutputMultiplier),
    },
    reasoningEfforts: row.reasoningEfforts
      .map((entry) => entry.effort.key)
      .sort(),
    sortOrder: row.sortOrder,
  };
}

export const MODEL_SELECT = {
  modelId: true,
  label: true,
  name: true,
  hint: true,
  description: true,
  iconSvg: true,
  contextWindowTokens: true,
  maxInputTokens: true,
  maxOutputTokens: true,
  inputPricePerMTokens: true,
  cachedInputPricePerMTokens: true,
  outputPricePerMTokens: true,
  cacheWriteMultiplier: true,
  longPromptThresholdTokens: true,
  longPromptInputMultiplier: true,
  longPromptOutputMultiplier: true,
  outputType: true,
  inputModalities: true,
  outputModalities: true,
  imageCapabilities: true,
  sortOrder: true,
  provider: { select: { slug: true, name: true } },
  reasoningEfforts: {
    select: { effort: { select: { key: true } } },
    orderBy: { effort: { sortOrder: "asc" } },
  },
} as const;

export async function listModels(): Promise<{
  models: ModelInfo[];
  reasoningEfforts: ReasoningEffortInfo[];
}> {
  const [models, reasoningEfforts] = await Promise.all([
    prisma.chatModel.findMany({
      where: { isActive: true, provider: { isActive: true } },
      select: MODEL_SELECT,
      orderBy: [{ sortOrder: "asc" }, { modelId: "asc" }],
    }),
    prisma.reasoningEffort.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: "asc" },
      select: { key: true, label: true, description: true, sortOrder: true },
    }),
  ]);

  return {
    models: models.map(toModelInfo),
    reasoningEfforts: reasoningEfforts.map((row) => ({
      key: row.key,
      label: row.label,
      description: row.description,
      sortOrder: row.sortOrder,
    })),
  };
}

export async function findActiveModel(modelId: string): Promise<ModelInfo | null> {
  const row = await prisma.chatModel.findFirst({
    where: { modelId, isActive: true, provider: { isActive: true } },
    select: MODEL_SELECT,
  });
  return row ? toModelInfo(row) : null;
}

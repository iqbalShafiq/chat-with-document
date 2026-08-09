import type { Prisma } from "../src/generated/prisma/client.js";
import { prisma } from "../src/utils/prisma.js";
import { buildSeedUpsertPairs, canonicalizeValue } from "./seed-helpers.js";

/**
 * Authoritative model registry seed. The registry tables are fully owned by
 * this seed, which now runs in UPSERT mode: providers, models and reasoning
 * efforts are matched by their unique business id (slug / modelId / key) and
 * created or updated in place — the registry is no longer destroyed on every
 * run. Reasoning-effort junctions for seed-owned models are rebuilt from the
 * seed (delete + recreate) so effort-key changes always converge, model rows
 * that left the seed are pruned, and unchanged rows are left untouched.
 */

const PROVIDERS = [
  { slug: "openai", name: "OpenAI", sortOrder: 0 },
  { slug: "deepseek", name: "DeepSeek", sortOrder: 1 },
  { slug: "google", name: "Google", sortOrder: 2 },
  { slug: "xai", name: "xAI", sortOrder: 3 },
];

/** OpenAI wordmark mark (hexagonal bloom), theme-adaptive via currentColor. */
const OPENAI_ICON_SVG = `<svg viewBox="0 0 324 320" fill="none" aria-hidden="true"><path fill="currentColor" d="M123.2,118.3V85c0-2.2,0.6-3.8,2.9-5.1L187.9,44c8.3-4.8,18.9-7,29.2-7c39.1,0,63.8,30.1,63.8,62.5c0,2.6,0,6.1-0.6,9l-64.7-37.8c-3.2-1.9-6.7-2.2-10.6,0L123.2,118.3z M266.1,236.6v-74c0-4.2-1.6-7-5.4-9.3l-82-47.7l28.8-16.7c1.6-1,4.2-1,5.8,0l62.2,35.9c17.6,10.3,29.8,32.7,29.8,54.1C305.2,204.2,289.8,227.6,266.1,236.6z M106.2,172.8l-28.5-17c-2.2-1.3-2.9-2.9-2.9-5.1V79.3c0-34.9,26.6-61.2,62.8-61.2c14.1,0,27.6,4.8,38.4,13.5L111.7,69c-3.8,2.2-5.4,5.1-5.4,9.3V172.8z M162,204.9l-38.8-21.8v-46.1l38.8-21.8l38.4,21.8v46.1L162,204.9z M186,301.9c-14.1,0-27.6-4.8-38.4-13.5L212,251c3.8-2.2,5.4-5.1,5.4-9.3v-94.5l28.8,17c2.2,1.3,2.9,2.9,2.9,5.1v71.5C249.1,275.7,222.2,301.9,186,301.9z M110.4,231.1l-62.2-35.9c-17.6-10.3-29.8-32.7-29.8-54.1c0-25.6,15.7-48.7,39.4-57.7v74.3c0,4.2,1.6,7,5.4,9.3l81.7,47.4l-28.8,16.7C114.6,232.1,112,232.1,110.4,231.1z M106.5,283c-36.8,0-63.8-27.6-63.8-61.8c0-3.2,0.3-6.4,0.6-9.3l64.4,37.2c3.8,2.2,7,2.2,10.9,0l81.7-47.4V235c0,2.2-0.6,3.8-2.9,5.1L135.7,276C127.4,280.8,116.8,283,106.5,283z M186,319.2c38.4,0,70.5-27.6,77.5-64.1c35.9-9,59-42.3,59-76.3c0-22.4-9.6-43.9-27.2-59.6c1.6-6.7,2.9-13.8,2.9-20.5c0-45.2-36.8-79.1-79.1-79.1c-8.7,0-17.3,1.6-25.6,4.5C179,9.7,159.4,0.8,137.6,0.8c-38.4,0-70.5,27.6-77.5,64.1c-35.9,9-59,42.3-59,76.3c0,22.4,9.6,43.9,27.2,59.6c-1.6,6.7-2.9,13.8-2.9,20.5c0,45.2,36.8,79.1,79.1,79.1c8.7,0,17.3-1.6,25.6-4.5C144.7,310.3,164.2,319.2,186,319.2z"/></svg>`;

/** DeepSeek whale mark, brand blue (#4d6bfe). */
const DEEPSEEK_ICON_SVG = `<svg viewBox="0 0 62 42" fill="none" aria-hidden="true"><path fill="#4d6bfe" d="M55.6128,3.4712c-.5953-.2917-.8517.2642-1.1998.5466-.1191.0911-.2198.2095-.3206.3188-.8701.9292-1.8867,1.5398-3.2148,1.4668-1.9417-.1094-3.5995.5012-5.065,1.9863-.3114-1.8313-1.3463-2.9248-2.9217-3.6262-.8242-.3645-1.6577-.729-2.2348-1.5217-.403-.5647-.5129-1.1934-.7144-1.813-.1283-.3735-.2565-.7563-.687-.8201-.4671-.0728-.6503.3188-.8335.647-.7327,1.3394-1.0166,2.8154-.9892,4.3096.0641,3.3621,1.4838,6.0406,4.3047,7.9449.3206.2187.403.4372.3023.7563-.1924.656-.4214,1.2937-.6228,1.9497-.1283.4192-.3207.5103-.7694.3279-1.5479-.6467-2.8852-1.6035-4.0667-2.7605-2.0058-1.9407-3.8193-4.0818-6.0815-5.7583-.5312-.3918-1.0625-.7561-1.6121-1.1025-2.3081-2.2412.3023-4.0818.9068-4.3003.6319-.2278.2198-1.0115-1.8227-1.0022-2.0425.009-3.9109.6924-6.2922,1.6035-.348.1367-.7145.2368-1.09.3188-2.1615-.4099-4.4055-.5012-6.7502-.2368-4.4147.4919-7.9408,2.5784-10.5328,6.1409C.1914,13.1289-.5413,17.9941.3563,23.0691c.9434,5.3481,3.6727,9.7761,7.8676,13.2385,4.3506,3.5896,9.3606,5.3481,15.0758,5.011,3.4713-.2004,7.3364-.665,11.6961-4.355,1.099.5467,2.2531.7652,4.1674.9292,1.4746.1367,2.8943-.0728,3.9933-.3005,1.7219-.3645,1.6029-1.959.9801-2.2505-5.0466-2.3506-3.9385-1.394-4.9459-2.1685,2.5645-3.0339,6.4297-6.1865,7.9409-16.4001.119-.8108.0183-1.3211,0-1.9771-.0092-.4008.0824-.5556.5404-.6013,1.2639-.1458,2.4912-.4919,3.6178-1.1115,3.2698-1.7857,4.5886-4.7195,4.9-8.2364.0459-.5376-.0091-1.0935-.577-1.3757ZM27.119,35.123c-4.8909-3.8447-7.263-5.1113-8.2431-5.0566-.9159.0547-.751,1.1025-.5496,1.7859.2107.6741.4855,1.1389.8701,1.731.2656.3918.4489.9748-.2655,1.4123-1.5754.9749-4.314-.3281-4.4423-.3918-3.1872-1.877-5.8525-4.3553-7.7302-7.7444-1.8135-3.262-2.8667-6.7605-3.0408-10.4961-.0458-.9019.2198-1.221,1.1174-1.3848,1.1815-.2187,2.3997-.2644,3.5812-.0913,4.9918.729,9.2415,2.9612,12.8043,6.4963,2.0333,2.0135,3.572,4.419,5.1566,6.7696,1.6852,2.4963,3.4987,4.8745,5.8068,6.8242.8151.6833,1.4654,1.2026,2.0882,1.5854-1.8775.2095-5.01.2552-7.1532-1.4397ZM29.4637,20.0442c0-.4009.3206-.7197.7237-.7197.0916,0,.174.018.2473.0453.1008.0366.1924.0913.2656.1731.1283.1277.2015.3098.2015.5012,0,.4009-.3205.7197-.7234.7197s-.7145-.3188-.7145-.7197ZM36.7452,23.7798c-.4671.1914-.9342.3552-1.383.3735-.6961.0364-1.4563-.2461-1.8684-.5923-.6411-.5376-1.0991-.8381-1.2914-1.7766-.0825-.4009-.0367-1.0205.0367-1.3757.1648-.7654-.0184-1.2573-.5587-1.7039-.4397-.3645-.9984-.4646-1.6121-.4646-.229,0-.4395-.1003-.5953-.1823-.2565-.1275-.467-.4464-.2656-.8382.0641-.1274.3756-.4373.4489-.4919.8335-.4739,1.7952-.3189,2.6836.0364.8244.3371,1.4472.9567,2.3447,1.8313.9159,1.0568,1.0807,1.3486,1.6028,2.1411.4123.6196.7878,1.2573,1.0442,1.9863.1557.4556-.0458.8291-.5862,1.0569Z"/></svg>`;

/** Google Gemini four-point sparkle mark, theme-adaptive via currentColor. */
const GEMINI_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path fill="currentColor" d="M12 1.5c.9 5.9 4.6 9.6 10.5 10.5-5.9.9-9.6 4.6-10.5 10.5C11.1 16.6 7.4 12.9 1.5 12 7.4 11.1 11.1 7.4 12 1.5z"/></svg>`;

/** xAI Grok monogram mark (stylized X), theme-adaptive via currentColor. */
/** Grok official icon (Wikimedia): rounded square + spiral X mark, theme-adaptive. */
const GROK_ICON_SVG = `<svg viewBox="0 0 512 509.641" fill="none" aria-hidden="true"><path fill="currentColor" fill-opacity="0.14" d="M115.612 0h280.776C459.975 0 512 52.026 512 115.612v278.416c0 63.587-52.025 115.613-115.612 115.613H115.612C52.026 509.641 0 457.615 0 394.028V115.612C0 52.026 52.026 0 115.612 0z"/><path fill="currentColor" d="M213.235 306.019l178.976-180.002v.169l51.695-51.763c-.924 1.32-1.86 2.605-2.785 3.89-39.281 54.164-58.46 80.649-43.07 146.922l-.09-.101c10.61 45.11-.744 95.137-37.398 131.836-46.216 46.306-120.167 56.611-181.063 14.928l42.462-19.675c38.863 15.278 81.392 8.57 111.947-22.03 30.566-30.6 37.432-75.159 22.065-112.252-2.92-7.025-11.67-8.795-17.792-4.263l-124.947 92.341zm-25.786 22.437l-.033.034L68.094 435.217c7.565-10.429 16.957-20.294 26.327-30.149 26.428-27.803 52.653-55.359 36.654-94.302-21.422-52.112-8.952-113.177 30.724-152.898 41.243-41.254 101.98-51.661 152.706-30.758 11.23 4.172 21.016 10.114 28.638 15.639l-42.359 19.584c-39.44-16.563-84.629-5.299-112.207 22.313-37.298 37.308-44.84 102.003-1.128 143.81z"/></svg>`;

/**
 * Model ids follow the OpenRouter convention (provider/model-slug). Prices are
 * per 1M tokens. `reasoningEffortKeys` defines the effort levels each model
 * supports (empty = no reasoning → UI shows "None"). Image generators declare
 * `outputType: "image"` plus `imageCapabilities` and no reasoning efforts.
 */
const MODELS = [
  {
    providerSlug: "openai",
    modelId: "openai/gpt-5.6-luna",
    name: "GPT 5.6 Luna",
    label: "Luna",
    hint: "Fast • Lowest cost",
    description: "GPT-5.6 optimized for cost-sensitive, high-volume workloads.",
    contextWindowTokens: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    inputPricePerMTokens: "0.20",
    cachedInputPricePerMTokens: "0.02",
    outputPricePerMTokens: "1.20",
    sortOrder: 0,
    iconSvg: OPENAI_ICON_SVG,
    outputType: "text",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsReasoning: true,
    reasoningEffortKeys: ["low", "medium", "high"],
  },
  {
    providerSlug: "deepseek",
    modelId: "deepseek/deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash 0731",
    label: "V4 Flash 0731",
    hint: "Fast • 1M context",
    description:
      "DeepSeek V4 Flash 0731 — sparse MoE (13B active / 284B total), 1M-token context, released Jul 31 2026.",
    contextWindowTokens: 1_048_576,
    maxInputTokens: undefined,
    maxOutputTokens: 65_536,
    inputPricePerMTokens: "0.09",
    cachedInputPricePerMTokens: undefined,
    outputPricePerMTokens: "0.18",
    sortOrder: 1,
    iconSvg: DEEPSEEK_ICON_SVG,
    outputType: "text",
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsReasoning: true,
    reasoningEffortKeys: ["low", "high", "max"],
  },
  {
    providerSlug: "openai",
    modelId: "openai/gpt-5-image-mini",
    name: "GPT-5 Image Mini",
    label: "GPT-5 Image Mini",
    hint: "Fastest • $0.008/img",
    description: "OpenAI image generation, low cost. Supports transparent background.",
    contextWindowTokens: 0,
    outputType: "image",
    inputModalities: ["text", "image", "file"],
    outputModalities: ["image"],
    imageCapabilities: {
      quality: ["auto", "low", "medium", "high"],
      background: ["auto", "transparent", "opaque"],
      n: { min: 1, max: 10 },
      aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "auto"],
    },
    iconSvg: OPENAI_ICON_SVG,
    sortOrder: 0,
    supportsReasoning: false,
    reasoningEffortKeys: [],
  },
  {
    providerSlug: "google",
    modelId: "google/gemini-3.1-flash-lite-image",
    name: "Nano Banana 2 Lite",
    label: "Gemini Flash Lite Image",
    hint: "Cheapest • $0.03/img",
    description: "Google Nano Banana 2 Lite — rich aspect ratios at 1K.",
    contextWindowTokens: 0,
    outputType: "image",
    inputModalities: ["image", "text"],
    outputModalities: ["image", "text"],
    imageCapabilities: {
      resolutions: ["1K"],
      n: { min: 1, max: 1 },
      aspectRatios: ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"],
    },
    iconSvg: GEMINI_ICON_SVG,
    sortOrder: 1,
    supportsReasoning: false,
    reasoningEffortKeys: [],
  },
  {
    providerSlug: "xai",
    modelId: "x-ai/grok-imagine-image-quality",
    name: "Grok Imagine",
    label: "Grok Imagine (Quality)",
    hint: "1K/2K • $0.05–0.07/img",
    description: "xAI Grok Imagine — quality tier, 1K/2K resolutions.",
    contextWindowTokens: 0,
    outputType: "image",
    inputModalities: ["text", "image"],
    outputModalities: ["image"],
    imageCapabilities: {
      resolutions: ["1K", "2K"],
      n: { min: 1, max: 1 },
      aspectRatios: ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5", "19.5:9", "1:2", "2:1", "auto"],
    },
    iconSvg: GROK_ICON_SVG,
    sortOrder: 2,
    supportsReasoning: false,
    reasoningEffortKeys: [],
  },
];

const EFFORTS = [
  { key: "low", label: "Low", description: "Minimal reasoning tokens, fastest response.", sortOrder: 0 },
  { key: "medium", label: "Medium", description: "Balanced reasoning depth and latency.", sortOrder: 1 },
  { key: "high", label: "High", description: "Deep reasoning for complex tasks.", sortOrder: 2 },
  { key: "max", label: "Max", description: "Maximum reasoning depth, highest latency.", sortOrder: 3 },
];

/** Canonical, prisma-ready shape of a ChatModel row used for diff + upsert. */
type ModelComparableRow = {
  key: string;
  modelId: string;
  name: string;
  label: string;
  hint?: string;
  description?: string;
  contextWindowTokens: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  inputPricePerMTokens?: number;
  cachedInputPricePerMTokens?: number;
  outputPricePerMTokens?: number;
  sortOrder: number;
  iconSvg: string;
  supportsReasoning: boolean;
  outputType: string;
  inputModalities?: Prisma.InputJsonValue;
  outputModalities?: Prisma.InputJsonValue;
  imageCapabilities?: Prisma.InputJsonValue;
};

/**
 * Projects a MODELS entry onto the comparable/persisted row shape:
 * drops seed-only fields (providerSlug, reasoningEffortKeys), normalizes
 * price strings to numbers and canonicalizes the rest so the row compares
 * equal to what postgres returns (Decimal instances, jsonb key ordering).
 */
function toSeedModelRow(model: (typeof MODELS)[number]): ModelComparableRow {
  const {
    providerSlug: _providerSlug,
    reasoningEffortKeys: _ignored,
    ...rest
  } = model;
  const normalized = {
    ...rest,
    inputPricePerMTokens:
      rest.inputPricePerMTokens === undefined
        ? undefined
        : Number(rest.inputPricePerMTokens),
    cachedInputPricePerMTokens:
      rest.cachedInputPricePerMTokens === undefined
        ? undefined
        : Number(rest.cachedInputPricePerMTokens),
    outputPricePerMTokens:
      rest.outputPricePerMTokens === undefined
        ? undefined
        : Number(rest.outputPricePerMTokens),
  };
  return canonicalizeValue({
    key: model.modelId,
    ...normalized,
  }) as ModelComparableRow;
}

async function main() {
  // ── Providers ────────────────────────────────────────────────────────────
  const providerSeedRows = PROVIDERS.map((provider) => ({
    key: provider.slug,
    name: provider.name,
    sortOrder: provider.sortOrder,
  }));
  const providerRows = await prisma.modelProvider.findMany();
  const providerResult = buildSeedUpsertPairs(
    providerSeedRows,
    providerRows.map((row) => ({
      key: row.slug,
      name: row.name,
      sortOrder: row.sortOrder,
    })),
  );
  const upsertProvider = (
    slug: string,
    data: { name: string; sortOrder: number },
  ) =>
    prisma.modelProvider.upsert({
      where: { slug },
      update: { name: data.name, sortOrder: data.sortOrder },
      create: { slug, name: data.name, sortOrder: data.sortOrder },
    });
  await prisma.$transaction([
    ...providerResult.create.map((row) =>
      upsertProvider(row.key, { name: row.name, sortOrder: row.sortOrder }),
    ),
    ...providerResult.update.map((row) =>
      upsertProvider(row.where, { name: row.data.name, sortOrder: row.data.sortOrder }),
    ),
  ]);

  // ── Reasoning efforts ────────────────────────────────────────────────────
  const effortRows = await prisma.reasoningEffort.findMany();
  const effortResult = buildSeedUpsertPairs(
    EFFORTS,
    effortRows.map((row) => ({
      key: row.key,
      label: row.label,
      description: row.description ?? undefined,
      sortOrder: row.sortOrder,
    })),
  );
  const upsertEffort = (
    key: string,
    data: { label: string; description?: string; sortOrder: number },
  ) =>
    prisma.reasoningEffort.upsert({
      where: { key },
      update: {
        label: data.label,
        description: data.description,
        sortOrder: data.sortOrder,
      },
      create: {
        key,
        label: data.label,
        description: data.description,
        sortOrder: data.sortOrder,
      },
    });
  await prisma.$transaction([
    ...effortResult.create.map((row) =>
      upsertEffort(row.key, {
        label: row.label,
        description: row.description,
        sortOrder: row.sortOrder,
      }),
    ),
    ...effortResult.update.map((row) =>
      upsertEffort(row.where, {
        label: row.data.label,
        description: row.data.description,
        sortOrder: row.data.sortOrder,
      }),
    ),
  ]);

  // ── Models ───────────────────────────────────────────────────────────────
  const existingModelRows = await prisma.chatModel.findMany();
  const modelResult = buildSeedUpsertPairs(
    MODELS.map(toSeedModelRow),
    existingModelRows.map((row) =>
      canonicalizeValue({
        key: row.modelId,
        modelId: row.modelId,
        name: row.name,
        label: row.label,
        hint: row.hint,
        description: row.description,
        contextWindowTokens: row.contextWindowTokens,
        maxInputTokens: row.maxInputTokens,
        maxOutputTokens: row.maxOutputTokens,
        inputPricePerMTokens: row.inputPricePerMTokens,
        cachedInputPricePerMTokens: row.cachedInputPricePerMTokens,
        outputPricePerMTokens: row.outputPricePerMTokens,
        sortOrder: row.sortOrder,
        iconSvg: row.iconSvg,
        supportsReasoning: row.supportsReasoning,
        outputType: row.outputType,
        inputModalities: row.inputModalities,
        outputModalities: row.outputModalities,
        imageCapabilities: row.imageCapabilities,
      }) as ModelComparableRow,
    ),
  );

  const providerRowsAfter = await prisma.modelProvider.findMany();
  const providerIdBySlug = new Map(providerRowsAfter.map((row) => [row.slug, row.id]));
  const providerSlugByModelId = new Map(
    MODELS.map((model) => [model.modelId, model.providerSlug]),
  );

  const upsertModel = (row: ModelComparableRow) => {
    const { key: modelId, modelId: _modelId, ...data } = row;
    const providerId = providerIdBySlug.get(providerSlugByModelId.get(modelId)!);
    if (!providerId) throw new Error(`unknown provider slug for model: ${modelId}`);
    return prisma.chatModel.upsert({
      where: { modelId },
      update: { ...data, providerId },
      create: { ...data, modelId, providerId },
    });
  };
  await prisma.$transaction([
    ...modelResult.create.map(upsertModel),
    ...modelResult.update.map((row) => upsertModel(row.data)),
  ]);

  // ── Reasoning-effort junctions (rebuild for seed-owned models) ───────────
  const seedModelIds = MODELS.map((model) => model.modelId);
  const seedModels = await prisma.chatModel.findMany({
    where: { modelId: { in: seedModelIds } },
  });
  const idByModelId = new Map(seedModels.map((row) => [row.modelId, row.id]));
  const effortRowsAfter = await prisma.reasoningEffort.findMany();
  const effortIdByKey = new Map(effortRowsAfter.map((row) => [row.key, row.id]));

  const junctionData = MODELS.flatMap((model) => {
    const modelRowId = idByModelId.get(model.modelId);
    if (!modelRowId) return [];
    return model.reasoningEffortKeys.flatMap((key) => {
      const effortId = effortIdByKey.get(key);
      return effortId ? [{ modelId: modelRowId, effortId }] : [];
    });
  });
  await prisma.$transaction([
    prisma.modelReasoningEffort.deleteMany({
      where: { modelId: { in: [...idByModelId.values()] } },
    }),
    prisma.modelReasoningEffort.createMany({
      data: junctionData,
      skipDuplicates: true,
    }),
  ]);

  // ── Prune models that left the seed ──────────────────────────────────────
  const removed = await prisma.chatModel.deleteMany({
    where: { modelId: { notIn: seedModelIds } },
  });

  const created =
    providerResult.create.length +
    effortResult.create.length +
    modelResult.create.length;
  const updated =
    providerResult.update.length +
    effortResult.update.length +
    modelResult.update.length;
  const unchanged =
    providerResult.unchanged + effortResult.unchanged + modelResult.unchanged;
  console.log(
    `[seed] created=${created} updated=${updated} unchanged=${unchanged} ` +
      `(providers=${providerResult.unchanged} models=${modelResult.unchanged} efforts=${effortResult.unchanged}) ` +
      `junctions=${junctionData.length} removed=${removed.count}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

import { prisma } from "../src/utils/prisma.js";

const PROVIDER_OPENAI = { slug: "openai", name: "OpenAI", sortOrder: 0 };

const MODELS = [
  {
    modelId: "gpt-5.6-luna",
    label: "Luna",
    hint: "Fastest · lowest cost",
    description: "GPT-5.6 optimized for cost-sensitive, high-volume workloads.",
    contextWindowTokens: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    inputPricePerMTokens: "0.20",
    cachedInputPricePerMTokens: "0.02",
    outputPricePerMTokens: "1.20",
    sortOrder: 0,
  },
  {
    modelId: "gpt-5.6-terra",
    label: "Terra",
    hint: "Balanced",
    description: "GPT-5.6 that balances intelligence and cost.",
    contextWindowTokens: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    inputPricePerMTokens: "2.00",
    cachedInputPricePerMTokens: "0.20",
    outputPricePerMTokens: "12.00",
    sortOrder: 1,
  },
  {
    modelId: "gpt-5.6-sol",
    label: "Sol",
    hint: "Highest quality",
    description: "GPT-5.6 frontier model for complex professional work.",
    contextWindowTokens: 1_050_000,
    maxInputTokens: 922_000,
    maxOutputTokens: 128_000,
    inputPricePerMTokens: "5.00",
    cachedInputPricePerMTokens: "0.50",
    outputPricePerMTokens: "30.00",
    sortOrder: 2,
  },
];

/** Same visual as the current lucide `Cpu` icon (16x16, stroke 1.75). */
const CPU_ICON_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="6" height="6" rx="1"/><path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2"/></svg>`;

const EFFORTS = [
  { key: "low", label: "Low", description: "Minimal reasoning tokens, fastest response.", sortOrder: 0 },
  { key: "medium", label: "Medium", description: "Balanced reasoning depth and latency.", sortOrder: 1 },
  { key: "high", label: "High", description: "Deep reasoning for complex tasks.", sortOrder: 2 },
];

async function main() {
  const provider = await prisma.modelProvider.upsert({
    where: { slug: PROVIDER_OPENAI.slug },
    update: { name: PROVIDER_OPENAI.name, sortOrder: PROVIDER_OPENAI.sortOrder },
    create: PROVIDER_OPENAI,
  });

  const efforts = await Promise.all(
    EFFORTS.map((effort) =>
      prisma.reasoningEffort.upsert({
        where: { key: effort.key },
        update: { label: effort.label, description: effort.description, sortOrder: effort.sortOrder },
        create: effort,
      }),
    ),
  );

  for (const model of MODELS) {
    const { modelId, ...rest } = model;
    const row = await prisma.chatModel.upsert({
      where: { modelId },
      update: { ...rest, providerId: provider.id, iconSvg: CPU_ICON_SVG },
      create: { ...rest, modelId, providerId: provider.id, iconSvg: CPU_ICON_SVG },
    });
    // Junction: every seeded model supports every effort.
    for (const effort of efforts) {
      await prisma.modelReasoningEffort.upsert({
        where: { modelId_effortId: { modelId: row.id, effortId: effort.id } },
        update: {},
        create: { modelId: row.id, effortId: effort.id },
      });
    }
  }

  console.log(`[seed] provider=${provider.slug} models=${MODELS.length} efforts=${efforts.length}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

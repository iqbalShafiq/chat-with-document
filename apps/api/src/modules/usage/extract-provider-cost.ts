/**
 * Extract monetary cost only when a provider payload actually includes it.
 * OpenAI Responses/Chat usage returns tokens, not USD — so this usually returns null.
 * Do not invent rates from pricing docs or hardcode per-model costs.
 */
export type ProviderCost = {
  totalCostUsd: number;
  currency: string;
  source: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Defensive parse of optional cost fields some gateways attach.
 * Standard OpenAI usage objects do not include these.
 */
export function extractProviderCostUsd(raw: unknown): ProviderCost | null {
  const root = asRecord(raw);
  if (!root) return null;

  const candidates: Array<{ value: unknown; source: string }> = [
    { value: root.cost, source: "raw.cost" },
    { value: root.total_cost, source: "raw.total_cost" },
    { value: root.totalCost, source: "raw.totalCost" },
  ];

  const usage = asRecord(root.usage);
  if (usage) {
    candidates.push(
      { value: usage.cost, source: "raw.usage.cost" },
      { value: usage.total_cost, source: "raw.usage.total_cost" },
      { value: usage.totalCost, source: "raw.usage.totalCost" },
    );
  }

  for (const candidate of candidates) {
    const amount = asFiniteNumber(candidate.value);
    if (amount === null || amount < 0) continue;
    return {
      totalCostUsd: amount,
      currency: "USD",
      source: candidate.source,
    };
  }

  return null;
}

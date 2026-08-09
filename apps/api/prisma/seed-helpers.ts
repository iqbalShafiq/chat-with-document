/**
 * Pure, database-free helpers for the model registry seed (prisma/seed.ts).
 * Keeping the diff logic here makes it unit-testable; seed.ts only wires it
 * to prisma.
 */

/**
 * Diffs seed rows against the current registry rows. Rows are matched by
 * their unique business `key` (provider slug, modelId or effort key).
 *
 * - create = rows in the seed but not in the database
 * - update = rows present in both but JSON-different
 * - unchanged = count of rows present in both and JSON-identical
 *
 * Pass `existingRows` canonicalized with `canonicalizeValue` so that prisma
 * Decimal values and jsonb key reordering never register as false changes.
 */
export function buildSeedUpsertPairs<T extends { key: string }>(
  seedRows: T[],
  existingRows: T[],
): { create: T[]; update: { where: string; data: T }[]; unchanged: number } {
  const existingByKey = new Map(existingRows.map((row) => [row.key, row]));
  const create: T[] = [];
  const update: { where: string; data: T }[] = [];
  let unchanged = 0;

  for (const seed of seedRows) {
    const existing = existingByKey.get(seed.key);
    if (!existing) {
      create.push(seed);
      continue;
    }
    if (JSON.stringify(existing) === JSON.stringify(seed)) {
      unchanged += 1;
    } else {
      update.push({ where: seed.key, data: seed });
    }
  }

  return { create, update, unchanged };
}

/**
 * Recursively normalizes a value so JSON comparison between a seed row and a
 * row read back from postgres is stable:
 *
 * - null/undefined collapse (jsonb reads NULL where the seed leaves a field
 *   unset)
 * - objects exposing toJSON() (prisma Decimal) become plain numbers
 * - plain object keys are sorted (jsonb reorders keys; insertion order is
 *   not preserved)
 * - array order is preserved (jsonb keeps array order)
 */
export function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(canonicalizeValue);
  if (typeof value === "object") {
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    // prisma Decimal's toJSON is a prototype method that reads `this` — call
    // it with the instance as receiver, never as a bare function.
    if (typeof toJSON === "function") {
      return Number((toJSON as () => unknown).call(value));
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalizeValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

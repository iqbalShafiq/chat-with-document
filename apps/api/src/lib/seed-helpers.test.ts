import { describe, expect, it } from "vitest";
import {
  buildSeedUpsertPairs,
  canonicalizeValue,
} from "../../prisma/seed-helpers.js";

type ProviderRow = { key: string; name: string; sortOrder: number };

describe("buildSeedUpsertPairs", () => {
  it("classifies a row absent from the database as create", () => {
    const seed: ProviderRow[] = [
      { key: "openai", name: "OpenAI", sortOrder: 0 },
    ];

    const result = buildSeedUpsertPairs(seed, []);

    expect(result.create).toEqual(seed);
    expect(result.update).toEqual([]);
    expect(result.unchanged).toBe(0);
  });

  it("classifies an identical row as unchanged", () => {
    const seed: ProviderRow[] = [
      { key: "openai", name: "OpenAI", sortOrder: 0 },
    ];
    const existing: ProviderRow[] = [
      { key: "openai", name: "OpenAI", sortOrder: 0 },
    ];

    const result = buildSeedUpsertPairs(seed, existing);

    expect(result.create).toEqual([]);
    expect(result.update).toEqual([]);
    expect(result.unchanged).toBe(1);
  });

  it("classifies a changed row as an update keyed by its key", () => {
    const seed: ProviderRow[] = [
      { key: "openai", name: "OpenAI", sortOrder: 1 },
    ];
    const existing: ProviderRow[] = [
      { key: "openai", name: "OpenAI", sortOrder: 0 },
    ];

    const result = buildSeedUpsertPairs(seed, existing);

    expect(result.create).toEqual([]);
    expect(result.update).toEqual([{ where: "openai", data: seed[0] }]);
    expect(result.unchanged).toBe(0);
  });

  it("handles a mixed set of new, changed and identical rows", () => {
    const seed: ProviderRow[] = [
      { key: "openai", name: "OpenAI", sortOrder: 0 },
      { key: "google", name: "Google", sortOrder: 1 },
      { key: "xai", name: "xAI", sortOrder: 3 },
    ];
    const existing: ProviderRow[] = [
      { key: "openai", name: "OpenAI", sortOrder: 0 },
      { key: "xai", name: "xAI", sortOrder: 2 },
    ];

    const result = buildSeedUpsertPairs(seed, existing);

    expect(result.create).toEqual([
      { key: "google", name: "Google", sortOrder: 1 },
    ]);
    expect(result.update).toEqual([
      { where: "xai", data: { key: "xai", name: "xAI", sortOrder: 3 } },
    ]);
    expect(result.unchanged).toBe(1);
  });

  it("treats nested json fields as part of the comparison", () => {
    type ImageRow = {
      key: string;
      imageCapabilities: {
        n: { min: number; max: number };
        resolutions: string[];
      };
    };
    const seed: ImageRow[] = [
      {
        key: "grok",
        imageCapabilities: { n: { min: 1, max: 1 }, resolutions: ["1K", "2K"] },
      },
    ];
    const existing: ImageRow[] = [
      {
        key: "grok",
        imageCapabilities: { n: { min: 1, max: 1 }, resolutions: ["1K"] },
      },
    ];

    const result = buildSeedUpsertPairs(seed, existing);

    expect(result.update).toHaveLength(1);
    expect(result.unchanged).toBe(0);
  });

  it("ignores existing rows that are not in the seed", () => {
    const seed: ProviderRow[] = [
      { key: "openai", name: "OpenAI", sortOrder: 0 },
    ];
    const existing: ProviderRow[] = [
      { key: "openai", name: "OpenAI", sortOrder: 0 },
      { key: "retired", name: "Retired", sortOrder: 9 },
    ];

    const result = buildSeedUpsertPairs(seed, existing);

    expect(result.create).toEqual([]);
    expect(result.update).toEqual([]);
    expect(result.unchanged).toBe(1);
  });
});

describe("canonicalizeValue", () => {
  it("collapses null and undefined", () => {
    expect(canonicalizeValue(null)).toBeUndefined();
    expect(canonicalizeValue(undefined)).toBeUndefined();
  });

  it("normalizes decimal-like values (prisma Decimal) to numbers", () => {
    // Prototype-method style, like prisma Decimal: toJSON reads `this`.
    const decimal = {
      value: "0.20",
      toJSON(this: { value: string }) {
        return this.value;
      },
    };
    expect(canonicalizeValue(decimal)).toBe(0.2);
  });

  it("recursively sorts object keys so key order does not matter", () => {
    const a = canonicalizeValue({ b: 1, a: { d: 4, c: 3 } });
    const b = canonicalizeValue({ a: { c: 3, d: 4 }, b: 1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("preserves array order", () => {
    expect(canonicalizeValue(["b", "a"])).toEqual(["b", "a"]);
  });

  it("normalizes nulls inside nested objects", () => {
    expect(canonicalizeValue({ hint: null, n: 1 })).toEqual({ n: 1 });
  });
});

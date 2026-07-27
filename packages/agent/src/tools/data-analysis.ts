import { createTool } from "@anvia/core";
import z from "zod";

const nonEmptyNumbers = z
  .array(z.number().finite())
  .min(1, "At least one number is required");

function assertSameLength(x: number[], y: number[]) {
  if (x.length !== y.length) {
    throw new Error(
      `Series must have the same length (got ${x.length} and ${y.length})`,
    );
  }
}

function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sortedCopy(values: number[]) {
  return [...values].sort((a, b) => a - b);
}

function quantile(sorted: number[], q: number) {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sorted[base]!;
  const upper = sorted[Math.min(base + 1, sorted.length - 1)]!;
  return lower + rest * (upper - lower);
}

function sampleVariance(values: number[], average = mean(values)) {
  if (values.length < 2) return 0;
  const squared = values.reduce(
    (sum, value) => sum + (value - average) ** 2,
    0,
  );
  return squared / (values.length - 1);
}

function sampleStdDev(values: number[], average = mean(values)) {
  return Math.sqrt(sampleVariance(values, average));
}

function mode(values: number[]) {
  const counts = new Map<number, number>();
  let maxCount = 0;

  for (const value of values) {
    const next = (counts.get(value) ?? 0) + 1;
    counts.set(value, next);
    if (next > maxCount) maxCount = next;
  }

  if (maxCount <= 1) return null;

  return [...counts.entries()]
    .filter(([, count]) => count === maxCount)
    .map(([value]) => value)
    .sort((a, b) => a - b);
}

function pearsonCorrelation(x: number[], y: number[]) {
  assertSameLength(x, y);
  if (x.length < 2) {
    throw new Error("Correlation requires at least 2 paired observations");
  }

  const meanX = mean(x);
  const meanY = mean(y);
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;

  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - meanX;
    const dy = y[i]! - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }

  if (denomX === 0 || denomY === 0) {
    throw new Error(
      "Correlation is undefined when one series has zero variance",
    );
  }

  return numerator / Math.sqrt(denomX * denomY);
}

function correlationStrength(r: number) {
  const abs = Math.abs(r);
  if (abs >= 0.9) return "very_strong";
  if (abs >= 0.7) return "strong";
  if (abs >= 0.4) return "moderate";
  if (abs >= 0.2) return "weak";
  return "very_weak";
}

export function createDataAnalysisTool() {
  const descriptiveStatsTool = createTool({
    name: "descriptive_stats",
    description:
      "Compute descriptive statistics for a numeric series: count, mean, median, mode, min/max, range, quartiles, IQR, variance, standard deviation, and skewness.",
    input: z.object({
      values: nonEmptyNumbers.describe("Numeric values to summarize"),
    }),
    execute: async ({ values }) => {
      const sorted = sortedCopy(values);
      const avg = mean(values);
      const variance = sampleVariance(values, avg);
      const stdDev = Math.sqrt(variance);
      const q1 = quantile(sorted, 0.25);
      const q2 = quantile(sorted, 0.5);
      const q3 = quantile(sorted, 0.75);
      const min = sorted[0]!;
      const max = sorted[sorted.length - 1]!;

      // Fisher-Pearson sample skewness (bias-adjusted for n >= 3)
      let skewness: number | null = null;
      if (values.length >= 3 && stdDev > 0) {
        const n = values.length;
        const m3 =
          values.reduce((sum, value) => sum + (value - avg) ** 3, 0) / n;
        skewness =
          (Math.sqrt(n * (n - 1)) / (n - 2)) * (m3 / stdDev ** 3);
      }

      return {
        count: values.length,
        mean: avg,
        median: q2,
        mode: mode(values),
        min,
        max,
        range: max - min,
        q1,
        q3,
        iqr: q3 - q1,
        variance,
        stdDev,
        skewness,
      };
    },
  });

  const correlationTool = createTool({
    name: "pearson_correlation",
    description:
      "Calculate the Pearson correlation coefficient between two paired numeric series, including covariance and a qualitative strength label.",
    input: z.object({
      x: nonEmptyNumbers.describe("First numeric series"),
      y: nonEmptyNumbers.describe("Second numeric series (same length as x)"),
    }),
    execute: async ({ x, y }) => {
      assertSameLength(x, y);
      const n = x.length;
      const meanX = mean(x);
      const meanY = mean(y);
      const covariance =
        n < 2
          ? 0
          : x.reduce(
              (sum, value, index) =>
                sum + (value - meanX) * (y[index]! - meanY),
              0,
            ) /
            (n - 1);

      const r = pearsonCorrelation(x, y);

      return {
        n,
        meanX,
        meanY,
        covariance,
        correlation: r,
        direction: r > 0 ? "positive" : r < 0 ? "negative" : "none",
        strength: correlationStrength(r),
        rSquared: r * r,
      };
    },
  });

  const linearRegressionTool = createTool({
    name: "linear_regression",
    description:
      "Fit a simple linear regression (y = slope * x + intercept). Returns slope, intercept, R², residual stats, and optional predictions for new x values.",
    input: z.object({
      x: nonEmptyNumbers.describe("Independent variable values"),
      y: nonEmptyNumbers.describe(
        "Dependent variable values (same length as x)",
      ),
      predictFor: z
        .array(z.number().finite())
        .optional()
        .describe("Optional x values to generate predictions for"),
    }),
    execute: async ({ x, y, predictFor }) => {
      assertSameLength(x, y);
      if (x.length < 2) {
        throw new Error("Linear regression requires at least 2 observations");
      }

      const meanX = mean(x);
      const meanY = mean(y);
      let ssxx = 0;
      let ssxy = 0;
      let ssyy = 0;

      for (let i = 0; i < x.length; i++) {
        const dx = x[i]! - meanX;
        const dy = y[i]! - meanY;
        ssxx += dx * dx;
        ssxy += dx * dy;
        ssyy += dy * dy;
      }

      if (ssxx === 0) {
        throw new Error(
          "Cannot fit regression when all x values are identical",
        );
      }

      const slope = ssxy / ssxx;
      const intercept = meanY - slope * meanX;
      const rSquared = ssyy === 0 ? 1 : (ssxy * ssxy) / (ssxx * ssyy);

      const residuals = y.map(
        (value, index) => value - (slope * x[index]! + intercept),
      );
      const residualStdDev = sampleStdDev(residuals);

      const predictions =
        predictFor?.map((value) => ({
          x: value,
          yHat: slope * value + intercept,
        })) ?? [];

      return {
        n: x.length,
        equation: `y = ${slope} * x + ${intercept}`,
        slope,
        intercept,
        rSquared,
        residualStdDev,
        residualMean: mean(residuals),
        predictions,
      };
    },
  });

  return [descriptiveStatsTool, correlationTool, linearRegressionTool];
}

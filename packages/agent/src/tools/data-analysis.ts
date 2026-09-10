function assertSameLength(x: number[], y: number[]) {
  if (x.length !== y.length) {
    throw new Error(
      `Series must have the same length (got ${x.length} and ${y.length})`,
    );
  }
}

export function mean(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function quantileSorted(sorted: number[], q: number) {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sorted[base]!;
  const upper = sorted[Math.min(base + 1, sorted.length - 1)]!;
  return lower + rest * (upper - lower);
}

export function sampleVariance(values: number[], average = mean(values)) {
  if (values.length < 2) return 0;
  const squared = values.reduce(
    (sum, value) => sum + (value - average) ** 2,
    0,
  );
  return squared / (values.length - 1);
}

export function sampleStdDev(values: number[], average = mean(values)) {
  return Math.sqrt(sampleVariance(values, average));
}

export function mode(values: number[]) {
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

export function pearsonCorrelation(x: number[], y: number[]) {
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



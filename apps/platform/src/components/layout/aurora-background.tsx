import { useMemo } from "react";

type AuroraBlob = {
  id: number;
  top: string;
  left: string;
  size: string;
  duration: string;
  delay: string;
  opacity: number;
  /** Warm accent stops — kept desaturated so the scene stays black-led */
  core: string;
  mid: string;
};

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function createBlobs(count: number): AuroraBlob[] {
  // Warm amber family (matches CTA accent), kept quiet against near-black canvas
  const palettes = [
    { core: "rgba(232, 163, 23, 0.22)", mid: "rgba(232, 163, 23, 0.05)" },
    { core: "rgba(194, 98, 28, 0.18)", mid: "rgba(120, 60, 20, 0.04)" },
    { core: "rgba(255, 200, 80, 0.12)", mid: "rgba(180, 120, 40, 0.03)" },
    { core: "rgba(160, 90, 40, 0.16)", mid: "rgba(80, 45, 20, 0.04)" },
  ];

  return Array.from({ length: count }, (_, id) => {
    const palette = palettes[id % palettes.length]!;
    const sizeVw = randomBetween(28, 52);
    return {
      id,
      top: `${randomBetween(-18, 78)}%`,
      left: `${randomBetween(-18, 78)}%`,
      size: `min(${sizeVw}vw, ${Math.round(sizeVw * 11)}px)`,
      duration: `${randomBetween(48, 72)}s`,
      delay: `${-randomBetween(0, 40)}s`,
      opacity: randomBetween(0.22, 0.38),
      core: palette.core,
      mid: palette.mid,
    };
  });
}

/** Module-level cache so Strict Mode remounts (and rare re-creates) keep the same scene. */
let cachedBlobs: AuroraBlob[] | null = null;

function getBlobs() {
  if (!cachedBlobs) cachedBlobs = createBlobs(4);
  return cachedBlobs;
}

export function AuroraBackground() {
  // Stable layout for the SPA session (root-mounted; not re-seeded on navigation).
  const blobs = useMemo(() => getBlobs(), []);

  return (
    <div className="aurora-root" aria-hidden>
      {blobs.map((blob) => (
        <div
          key={blob.id}
          className="aurora-blob"
          style={{
            top: blob.top,
            left: blob.left,
            width: blob.size,
            height: blob.size,
            opacity: blob.opacity,
            animationDuration: blob.duration,
            animationDelay: blob.delay,
            background: `radial-gradient(circle, ${blob.core} 0%, ${blob.mid} 42%, transparent 70%)`,
          }}
        />
      ))}
      <div className="aurora-grain" />
    </div>
  );
}

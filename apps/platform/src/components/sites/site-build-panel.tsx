import type { SiteBuildProgress, SiteBuildReady } from "../../lib/chat/client-data.js";

export const SITE_BUILD_PHASES = [
  { phase: "starting", label: "Menyiapkan" },
  { phase: "planning", label: "Menyusun brief" },
  { phase: "building", label: "Membangun halaman" },
  { phase: "bundling", label: "Build production" },
  { phase: "preview", label: "Menyiapkan pratinjau" },
  { phase: "ready", label: "Siap" },
] as const;

export type SiteBuildPhaseName = (typeof SITE_BUILD_PHASES)[number]["phase"] | "failed";

export type SiteBuildState = {
  siteId: string;
  version: number;
  phase: SiteBuildPhaseName;
  message: string;
  previewUrl: string | null;
  downloadUrl: string | null;
};

export function phaseIndex(phase: SiteBuildPhaseName): number {
  const index = SITE_BUILD_PHASES.findIndex((entry) => entry.phase === phase);
  return index === -1 ? SITE_BUILD_PHASES.length : index;
}

export function applySiteBuildEvent(
  state: SiteBuildState | null,
  event: { name: "siteBuildProgress"; data: SiteBuildProgress } | { name: "siteBuildReady"; data: SiteBuildReady },
): SiteBuildState {
  if (event.name === "siteBuildProgress") {
    const keep = state?.siteId === event.data.siteId ? state : null;
    return {
      siteId: event.data.siteId,
      version: event.data.version,
      phase: event.data.phase,
      message: event.data.message,
      previewUrl: keep?.previewUrl ?? null,
      downloadUrl: keep?.downloadUrl ?? null,
    };
  }
  return {
    siteId: event.data.siteId,
    version: event.data.version,
    phase: "ready",
    message: "Situs siap diunduh.",
    previewUrl: event.data.previewUrl,
    downloadUrl: event.data.downloadUrl,
  };
}

export function SiteBuildPanel({
  build,
  onRetry,
}: {
  build: SiteBuildState | null;
  onRetry: (siteId: string) => void;
}) {
  if (!build) return null;
  const active = phaseIndex(build.phase);
  return (
    <section aria-label="Site build">
      <p>
        v{build.version} · {build.message}
      </p>
      <ol>
        {SITE_BUILD_PHASES.map((entry, index) => (
          <li
            key={entry.phase}
            aria-current={index === active ? "step" : undefined}
            data-state={index < active ? "done" : index === active ? "active" : "todo"}
          >
            {entry.label}
          </li>
        ))}
      </ol>
      {build.phase === "failed" ? (
        <button type="button" onClick={() => onRetry(build.siteId)}>
          Coba lagi
        </button>
      ) : null}
      {build.previewUrl ? (
        <iframe title={`Preview ${build.siteId}`} src={build.previewUrl} sandbox="allow-scripts" />
      ) : (
        <div role="status">Pratinjau segera hadir.</div>
      )}
      {build.downloadUrl ? <a href={build.downloadUrl} download>Unduh zip</a> : null}
    </section>
  );
}

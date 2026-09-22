import { Check, Loader2 } from "lucide-react";
import { Button } from "#/components/ui/button";
import { API_BASE } from "#/lib/api";
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

export type SiteVersionEntry = {
  version: number;
  status: "queued" | "running" | "ready" | "failed";
  stable: boolean;
  previewUrl: string | null;
  downloadUrl: string | null;
};

export function phaseIndex(phase: SiteBuildPhaseName): number {
  const index = SITE_BUILD_PHASES.findIndex((entry) => entry.phase === phase);
  return index === -1 ? SITE_BUILD_PHASES.length : index;
}

export function resolveSiteUrl(value: string): string {
  return value.startsWith("/api/sites/") ? `${API_BASE}${value}` : value;
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
  versions,
  onRetry,
  onRollback,
}: {
  build: SiteBuildState | null;
  versions: SiteVersionEntry[];
  onRetry: (siteId: string) => void;
  onRollback: (siteId: string, version: number) => void;
}) {
  if (!build) return null;
  const active = phaseIndex(build.phase);
  const isFailed = build.phase === "failed";
  return (
    <section
      aria-label="Site build"
      className={`glass rounded-xl border px-3 py-2.5 animate-fade-in ${
        isFailed
          ? "border-danger/25 bg-danger-soft/40"
          : "border-accent/20 bg-accent/[0.04]"
      }`}
    >
      <p>
        v{build.version} · {build.message}
      </p>
      <ol>
        {SITE_BUILD_PHASES.map((entry, index) => {
          const stepState = index < active ? "done" : index === active ? "active" : "todo";
          return (
            <li
              key={entry.phase}
              aria-current={index === active ? "step" : undefined}
              data-state={stepState}
              className={
                stepState === "active"
                  ? "flex items-center gap-1.5 text-[11px] font-semibold text-accent"
                  : stepState === "done"
                    ? "flex items-center gap-1.5 text-[11px] font-medium text-text-muted"
                    : "flex items-center gap-1.5 text-[11px] text-text-faint"
              }
            >
              {stepState === "done" ? (
                <Check className="size-3.5 text-accent" strokeWidth={2.25} aria-hidden="true" />
              ) : stepState === "active" ? (
                <Loader2
                  className="size-3.5 animate-spin text-accent motion-reduce:animate-none"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              ) : null}
              {entry.label}
            </li>
          );
        })}
      </ol>
      {build.phase === "failed" ? (
        <Button size="sm" variant="secondary" onClick={() => onRetry(build.siteId)}>
          Coba lagi
        </Button>
      ) : null}
      {build.previewUrl ? (
        <iframe title={`Preview ${build.siteId}`} src={resolveSiteUrl(build.previewUrl)} sandbox="allow-scripts" />
      ) : (
        <div role="status" className="skeleton-shimmer rounded-lg px-3 py-2.5 text-[11px] text-text-muted">Pratinjau segera hadir.</div>
      )}
      {build.downloadUrl ? <a href={resolveSiteUrl(build.downloadUrl)} download>Unduh zip</a> : null}
      {versions.length > 1 ? (
        <ol aria-label="Versi">
          {versions.map((entry) => (
            <li key={entry.version}>
              v{entry.version}
              {entry.stable ? " (stabil)" : null}
              {!entry.stable && entry.status === "ready" ? (
                <Button size="sm" variant="secondary" onClick={() => onRollback(build.siteId, entry.version)}>Rollback</Button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

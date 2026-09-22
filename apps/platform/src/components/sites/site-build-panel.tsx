import { useId, useState } from "react";
import { Check, ChevronDown, Download, Expand, Loader2 } from "lucide-react";
import { Button, BUTTON_BASE_CLASS, BUTTON_SIZE_CLASSES, BUTTON_VARIANT_CLASSES } from "#/components/ui/button";
import { DialogShell } from "#/components/ui/dialog-shell";
import { Select } from "#/components/ui/select";
import type { SelectOption } from "#/components/ui/select-list";
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

const VERSION_STATUS_LABELS: Record<SiteVersionEntry["status"], string> = {
  queued: "menunggu",
  running: "berjalan",
  ready: "siap",
  failed: "gagal",
};

export type SiteBuildState = {
  siteId: string;
  version: number;
  phase: SiteBuildPhaseName;
  message: string;
  previewUrl: string | null;
  downloadUrl: string | null;
};

export type SiteVersionEntry = {
  siteId: string;
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

export function stableSiteUrls(
  siteId: string,
  version: number,
): { previewUrl: string; downloadUrl: string } {
  return {
    previewUrl: `/api/sites/${siteId}/v${version}/preview/index.html`,
    downloadUrl: `/api/sites/${siteId}/v${version}/download`,
  };
}

export function applySiteVersionEvent(
  state: SiteVersionEntry[],
  event: { name: "siteBuildProgress"; data: SiteBuildProgress } | { name: "siteBuildReady"; data: SiteBuildReady },
): SiteVersionEntry[] {
  const siteId = event.data.siteId;
  const version = event.data.version;
  const rest = state.some((entry) => entry.siteId !== siteId)
    ? []
    : state.filter((entry) => entry.version !== version);
  if (event.name === "siteBuildProgress") {
    const keep = state.find((entry) => entry.siteId === siteId && entry.version === version);
    const status: SiteVersionEntry["status"] =
      event.data.phase === "starting" ? "queued" : event.data.phase === "failed" ? "failed" : "running";
    return [
      ...rest,
      {
        siteId,
        version,
        status,
        stable: keep?.stable ?? false,
        previewUrl: keep?.previewUrl ?? null,
        downloadUrl: keep?.downloadUrl ?? null,
      },
    ].sort((a, b) => a.version - b.version);
  }
  const ready: SiteVersionEntry = {
    siteId,
    version,
    status: "ready",
    stable: true,
    previewUrl: event.data.previewUrl,
    downloadUrl: event.data.downloadUrl,
  };
  return [...rest.map((entry) => ({ ...entry, stable: false })), ready].sort(
    (a, b) => a.version - b.version,
  );
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
  const done = build.phase === "ready";
  const active = done ? SITE_BUILD_PHASES.length : phaseIndex(build.phase);
  const isFailed = build.phase === "failed";
  const [open, setOpen] = useState(true);
  const [previewOpen, setPreviewOpen] = useState(false);
  const bodyId = useId();
  const previewUrl = build.previewUrl ? resolveSiteUrl(build.previewUrl) : null;
  const downloadUrl = build.downloadUrl ? resolveSiteUrl(build.downloadUrl) : null;
  const sortedVersions = [...versions].sort((a, b) => b.version - a.version);
  const defaultVersion = versions.find((entry) => entry.stable)?.version
    ?? sortedVersions[0]?.version;
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(defaultVersion);
  const effectiveVersion = versions.some((entry) => entry.version === selectedVersion)
    ? selectedVersion
    : defaultVersion;
  const selectedEntry = versions.find((entry) => entry.version === effectiveVersion);
  const canRollback = selectedEntry?.status === "ready" && !selectedEntry.stable;
  const versionOptions: SelectOption[] = sortedVersions.map((entry) => ({
    value: String(entry.version),
    label: `v${entry.version}${entry.stable ? " (stabil)" : entry.status === "ready" ? "" : ` • ${VERSION_STATUS_LABELS[entry.status]}`}`,
  }));
  const versionControls = sortedVersions.length > 1 ? (
    <>
      <Select
        ariaLabel="Versi"
        value={effectiveVersion !== undefined ? String(effectiveVersion) : ""}
        onChange={(optionValue) => setSelectedVersion(Number(optionValue))}
        options={versionOptions}
        className="w-32 shrink-0"
      />
      <button
        type="button"
        disabled={!canRollback}
        title={canRollback ? `Kembalikan ke v${effectiveVersion}` : "Pilih versi ready yang bukan stabil"}
        onClick={() => {
          if (effectiveVersion !== undefined) onRollback(build.siteId, effectiveVersion);
        }}
        className="shrink-0 cursor-pointer rounded-lg px-1.5 py-1 text-[11px] font-medium text-text-muted transition duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:text-text active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
      >
        Rollback
      </button>
    </>
  ) : null;
  const downloadButtonClass = [
    BUTTON_BASE_CLASS,
    BUTTON_VARIANT_CLASSES.secondary,
    BUTTON_SIZE_CLASSES.sm,
  ].join(" ");
  return (
    <section
      aria-label="Site build"
      className={`glass rounded-xl border px-3 py-2 animate-fade-in ${
        isFailed
          ? "border-danger/25 bg-danger-soft/40"
          : "border-accent/20 bg-accent/[0.04]"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[12px] font-medium">
          v{build.version} · {build.message}
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((current) => !current)}
          className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-lg px-1.5 py-1 text-[10px] font-medium text-text-muted transition duration-150 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.06] hover:text-text active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <span>{open ? "Sembunyikan" : "Tampilkan"}</span>
          <ChevronDown
            className={`size-3 transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${
              open ? "rotate-180" : ""
            }`}
            strokeWidth={2}
          />
        </button>
      </div>
      <div id={bodyId} hidden={!open}>
        <div className="mt-1.5 flex flex-col gap-2.5">
          <ol className="flex flex-col gap-1">
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
          {previewUrl ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPreviewOpen(true)}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 self-stretch rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-left transition hover:bg-white/[0.07] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
              >
                <Expand className="size-3.5 shrink-0 text-text-muted" strokeWidth={2} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-text">
                  Lihat pratinjau
                </span>
              </button>
              {versionControls}
            </div>
          ) : (
            <>
              <div role="status" className="skeleton-shimmer rounded-lg px-3 py-2 text-[11px] text-text-muted">Pratinjau segera hadir.</div>
              {sortedVersions.length > 1 ? (
                <div className="flex items-center gap-2">
                  {versionControls}
                </div>
              ) : null}
            </>
          )}
          <div className="flex flex-wrap items-center gap-2">
            {downloadUrl ? (
              <a
                href={downloadUrl}
                download
                className={downloadButtonClass}
              >
                <Download className="size-3.5" strokeWidth={2} aria-hidden="true" />
                Unduh zip
              </a>
            ) : null}
            {build.phase === "failed" ? (
              <Button size="sm" variant="secondary" onClick={() => onRetry(build.siteId)}>
                Coba lagi
              </Button>
            ) : null}
          </div>
        </div>
      </div>
      <DialogShell
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={`Pratinjau v${build.version}`}
        size="xl"
        footer={
          downloadUrl ? (
            <a href={downloadUrl} download className={downloadButtonClass}>
              <Download className="size-3.5" strokeWidth={2} aria-hidden="true" />
              Unduh zip
            </a>
          ) : undefined
        }
      >
        {previewUrl ? (
          <iframe
            title={`Preview ${build.siteId}`}
            src={previewUrl}
            sandbox="allow-scripts"
            className="min-h-0 w-full flex-1 border-0"
          />
        ) : null}
      </DialogShell>
    </section>
  );
}

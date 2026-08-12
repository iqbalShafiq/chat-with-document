import { useState } from "react";
import { RotateCcw, Sparkles } from "lucide-react";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/ui/confirm-dialog";
import type {
  ExplicitFact,
  ProfileDto,
  ProfileSectionKey,
} from "#/lib/api";

const SECTION_LABELS: Record<ProfileSectionKey, string> = {
  facts: "Facts",
  preferences: "Preferences",
  interests: "Interests",
  expertise: "Expertise",
  goals: "Goals",
};

function formatRelativeTime(iso: string): string {
  const seconds = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(iso)) / 1000),
  );
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ProfileBody({ profile }: { profile: ProfileDto }) {
  const sectionEntries = (Object.keys(SECTION_LABELS) as ProfileSectionKey[])
    .map((key) => ({ key, label: SECTION_LABELS[key], items: profile.sections[key] }))
    .filter((entry) => entry.items.length > 0);

  if (sectionEntries.length === 0 && profile.explicitFacts.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-text-faint">
        No profile yet. It builds automatically from your chats.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {sectionEntries.map((entry) => (
        <div key={entry.key} className="flex flex-col gap-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
            {entry.label}
          </p>
          <ul className="flex flex-col gap-1">
            {entry.items.map((item, index) => (
              <li key={index} className="text-xs leading-relaxed text-text-muted">
                {item.text}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {profile.explicitFacts.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
            Remembered
          </p>
          <ul className="flex flex-col gap-1">
            {profile.explicitFacts.map((fact: ExplicitFact, index: number) => (
              <li key={index} className="text-xs leading-relaxed text-text">
                {fact.fact}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export type PersonalizationSectionProps = {
  data: {
    user: ProfileDto | null;
    projects: Array<{ id: string; name: string; profile: ProfileDto | null }>;
  } | null;
  loading: boolean;
  error: string | null;
  resetting: string | null;
  onResetUser: () => void;
  onResetProject: (projectId: string) => void;
};

export function PersonalizationSection({
  data,
  loading,
  error,
  resetting,
  onResetUser,
  onResetProject,
}: PersonalizationSectionProps) {
  const [confirmTarget, setConfirmTarget] = useState<
    { kind: "user" } | { kind: "project"; projectId: string; name: string } | null
  >(null);

  return (
    <div className="flex flex-col gap-6 animate-fade-in">
      <div>
        <h3 className="text-sm font-medium text-text">Personalization</h3>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">
          What the assistant knows about you, built automatically from your
          chats. Reset anytime to start fresh.
        </p>
      </div>

      {loading ? (
        <div className="flex flex-col gap-3">
          <div className="skeleton-shimmer h-24 w-full rounded-xl" />
          <div className="skeleton-shimmer h-20 w-full rounded-xl" />
        </div>
      ) : error ? (
        <p className="text-sm text-danger" role="alert">
          {error}
        </p>
      ) : data ? (
        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-3 rounded-xl border border-hairline bg-white/[0.02] p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-text-muted" strokeWidth={1.75} />
                <h4 className="text-sm font-medium text-text">Global profile</h4>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmTarget({ kind: "user" })}
                disabled={resetting === "user"}
              >
                <RotateCcw className="size-3.5" strokeWidth={1.75} />
                {resetting === "user" ? "Resetting…" : "Reset"}
              </Button>
            </div>
            {data.user ? (
              <>
                <ProfileBody profile={data.user} />
                <p className="text-[11px] text-text-faint">
                  Updated {formatRelativeTime(data.user.updatedAt)}
                </p>
              </>
            ) : (
              <p className="text-xs leading-relaxed text-text-faint">
                No profile yet. It builds automatically from your chats.
              </p>
            )}
          </section>

          {data.projects.length > 0 ? (
            <div className="flex flex-col gap-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-text-faint">
                Projects
              </p>
              {data.projects.map((project) => (
                <section
                  key={project.id}
                  className="flex flex-col gap-3 rounded-xl border border-hairline bg-white/[0.02] p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <h4 className="text-sm font-medium text-text">{project.name}</h4>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        setConfirmTarget({
                          kind: "project",
                          projectId: project.id,
                          name: project.name,
                        })
                      }
                      disabled={resetting === `project:${project.id}`}
                    >
                      <RotateCcw className="size-3.5" strokeWidth={1.75} />
                      {resetting === `project:${project.id}` ? "Resetting…" : "Reset"}
                    </Button>
                  </div>
                  {project.profile ? (
                    <ProfileBody profile={project.profile} />
                  ) : (
                    <p className="text-xs leading-relaxed text-text-faint">
                      No profile yet for this project.
                    </p>
                  )}
                </section>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmTarget !== null}
        title="Reset profile?"
        description={
          confirmTarget?.kind === "project"
            ? `This clears the profile for "${confirmTarget.name}" and starts it over from your next chats.`
            : "This clears your global profile and starts it over from your next chats."
        }
        confirmLabel="Reset"
        onConfirm={() => {
          if (!confirmTarget) return;
          if (confirmTarget.kind === "user") {
            onResetUser();
          } else {
            onResetProject(confirmTarget.projectId);
          }
          setConfirmTarget(null);
        }}
        onCancel={() => setConfirmTarget(null)}
      />
    </div>
  );
}

import { DialogShell } from "#/components/ui/dialog-shell";
import { ArtifactsRail } from "#/components/artifacts/artifacts-rail";

/** Sidebar entry point for the unified artifacts rail (tab counts + list). */
export function ArtifactsModal({
  open,
  onClose,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
}) {
  return (
    <DialogShell
      open={open}
      onClose={onClose}
      title="Artifacts"
      description="Everything in this scope: docs, images, sites, tasks."
      size="lg"
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        <ArtifactsRail sessionId={sessionId} />
      </div>
    </DialogShell>
  );
}

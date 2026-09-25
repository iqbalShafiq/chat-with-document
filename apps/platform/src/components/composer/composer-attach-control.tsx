import { useComposer } from "@anvia/react-ui";
import { FileText, FolderOpen, Globe, Paperclip, Upload } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { ArtifactPicker } from "#/components/artifacts/artifact-picker";
import { DocumentLibraryModal } from "#/components/documents/document-library-modal";
import { DialogShell } from "#/components/ui/dialog-shell";
import { PopoverMenu } from "#/components/ui/popover-menu";
import type { ArtifactType } from "#/lib/api-artifacts";
import { getArtifact } from "#/lib/api-artifacts";
import {
  linkDocumentsToSession,
  type SessionDocument,
  type UserLibraryDocument,
} from "#/lib/api";
import {
  ensureUploadableFile,
  validateDocumentFile,
  type AttachmentReject,
} from "#/lib/documents/upload-file";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.csv,.xlsx";

export function ComposerAttachControl({
  sessionId,
  projectId = null,
  activeDocumentIds,
  disabled = false,
  onLinkedDocuments,
  onRejectedFiles,
  onAttached,
  onPinArtifact,
}: {
  sessionId: string;
  projectId?: string | null;
  activeDocumentIds?: ReadonlySet<string>;
  disabled?: boolean;
  /** Called after library docs are linked so the parent can refresh Active. */
  onLinkedDocuments?: (documents: SessionDocument[]) => void;
  /** Called with client-side rejects (e.g. size limit) — never queued. */
  onRejectedFiles?: (rejects: AttachmentReject[]) => void;
  /** Called after anything is attached (pin, library, upload) so the parent can refocus the field. */
  onAttached?: () => void;
  /** Called when the user picks an artifact to pin (parent owns pin state). */
  onPinArtifact?: (ref: { type: ArtifactType; id: string; label: string }) => void;
}) {
  const composer = useComposer();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [pinType, setPinType] = useState<Extract<ArtifactType, "site" | "document"> | null>(null);

  const busy = disabled || linking;

  /**
   * Guardrail checks (size limit, …) run here — right when the user drops the
   * files — so invalid files are rejected immediately instead of failing on
   * submit. Rejects never enter the composer queue / Uploading documents rail.
   */
  const queueLocalFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const rejects: AttachmentReject[] = [];
      for (const file of files) {
        const message = validateDocumentFile(file);
        if (message !== null) {
          rejects.push({
            id: crypto.randomUUID(),
            filename: file.name,
            message,
          });
          continue;
        }
        // Fix empty MIME (common for PDF on Windows) before Anvia stores base64.
        await composer.addAttachment(ensureUploadableFile(file));
      }

      if (rejects.length > 0) {
        onRejectedFiles?.(rejects);
      }
      if (files.length > rejects.length) {
        onAttached?.();
      }
    },
    [composer, onAttached, onRejectedFiles],
  );

  const handlePinArtifact = useCallback(
    (id: string, label: string) => {
      if (!pinType) return;
      onPinArtifact?.({ type: pinType, id, label });
      setPinType(null);
      setMenuOpen(false);
      onAttached?.();
    },
    [onAttached, onPinArtifact, pinType],
  );

  const handleLibraryConfirm = useCallback(
    async (documents: UserLibraryDocument[]) => {
      setLinking(true);
      setLibraryError(null);
      try {
        const result = await linkDocumentsToSession({
          sessionId,
          documentIds: documents.map((d) => d.id),
        });
        onLinkedDocuments?.(result.linked);
        setLibraryOpen(false);
        onAttached?.();
      } catch (error) {
        setLibraryError(
          error instanceof Error
            ? error.message
            : "Failed to add documents to session",
        );
      } finally {
        setLinking(false);
      }
    },
    [onAttached, onLinkedDocuments, sessionId],
  );

  return (
    <>
      <div className="relative">
        <button
          ref={buttonRef}
          type="button"
          aria-label="Attach document"
          title="Attach document"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={busy}
          onClick={() => setMenuOpen((open) => !open)}
          className="glass glass-interactive inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:text-text active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Paperclip className="size-4" strokeWidth={1.75} />
        </button>

        <PopoverMenu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          anchorRef={buttonRef}
          label="Attach options"
          align="end"
          items={[
            {
              id: "upload",
              label: "Upload from computer",
              description: "PDF, image, or spreadsheet from this device",
              icon: <Upload className="size-3.5" strokeWidth={1.75} />,
              disabled: busy,
              onSelect: () => {
                fileInputRef.current?.click();
              },
            },
            {
              id: "library",
              label: "Choose uploaded files",
              description: "Pick from your document library",
              icon: <FolderOpen className="size-3.5" strokeWidth={1.75} />,
              disabled: busy,
              onSelect: () => {
                setLibraryError(null);
                setLibraryOpen(true);
              },
            },
            {
              id: "pin-site",
              label: "Pin a site",
              description: "Reference a static site from this scope",
              icon: <Globe className="size-3.5" strokeWidth={1.75} />,
              disabled: busy,
              onSelect: () => {
                setPinType("site");
              },
            },
            {
              id: "pin-report",
              label: "Pin a report",
              description: "Reference a PDF report from this scope",
              icon: <FileText className="size-3.5" strokeWidth={1.75} />,
              disabled: busy,
              onSelect: () => {
                setPinType("document");
              },
            },
          ]}
        />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        tabIndex={-1}
        aria-hidden
        disabled={busy}
        onChange={(event) => {
          // Snapshot first — FileList is live; clearing value empties it.
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          void queueLocalFiles(files);
        }}
      />

      <DocumentLibraryModal
        open={libraryOpen}
        onClose={() => {
          if (!linking) setLibraryOpen(false);
        }}
        activeDocumentIds={activeDocumentIds}
        projectId={projectId}
        onConfirm={handleLibraryConfirm}
        busy={linking}
        error={libraryError}
      />

      <DialogShell
        open={pinType !== null}
        onClose={() => setPinType(null)}
        title={pinType === "site" ? "Pin a site" : "Pin a report"}
        description="The reference is inserted into your message for the agent to resolve."
        size="md"
        heightMode="viewport"
      >
        <div className="relative min-h-0 min-w-0 flex-1">
          <div className="chat-scroll-bleed absolute inset-0 overflow-y-auto overscroll-contain p-4">
            <div className="flex flex-col gap-3">
        {pinType ? (
          <ArtifactPicker
            sessionId={sessionId}
            artifactType={pinType}
            value={null}
            candidates={undefined}
            filter={pinType === "document" ? (item) => item.kind === "report" : undefined}
            emptyHint="No PDF reports in this scope yet — ask the agent to build one."
            onSelect={(id) => {
              void getArtifact({ id, type: pinType, sessionId }).then(
                (artifact) => {
                  handlePinArtifact(
                    id,
                    artifact.caption ?? artifact.filename ?? artifact.title ?? id,
                  );
                },
                () => handlePinArtifact(id, id),
              );
            }}
          />
        ) : null}
            </div>
          </div>
        </div>
      </DialogShell>
    </>
  );
}

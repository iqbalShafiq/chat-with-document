import { useComposer } from "@anvia/react-ui";
import { FolderOpen, Paperclip, Upload } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { DocumentLibraryModal } from "#/components/documents/document-library-modal";
import { PopoverMenu } from "#/components/ui/popover-menu";
import {
  linkDocumentsToSession,
  type SessionDocument,
  type UserLibraryDocument,
} from "#/lib/api";
import { ensureUploadableFile } from "#/lib/documents/upload-file";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp";

export function ComposerAttachControl({
  sessionId,
  projectId = null,
  activeDocumentIds,
  disabled = false,
  onLinkedDocuments,
}: {
  sessionId: string;
  projectId?: string | null;
  activeDocumentIds?: ReadonlySet<string>;
  disabled?: boolean;
  /** Called after library docs are linked so the parent can refresh Active. */
  onLinkedDocuments?: (documents: SessionDocument[]) => void;
}) {
  const composer = useComposer();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [linking, setLinking] = useState(false);
  const [libraryError, setLibraryError] = useState<string | null>(null);

  const busy = disabled || linking;

  /** Queue on composer only (sidebar Attachments). Upload runs on Submit. */
  const queueLocalFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      for (const file of files) {
        // Fix empty MIME (common for PDF on Windows) before Anvia stores base64.
        await composer.addAttachment(ensureUploadableFile(file));
      }
    },
    [composer],
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
    [onLinkedDocuments, sessionId],
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
              description: "PDF or image from this device",
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
    </>
  );
}

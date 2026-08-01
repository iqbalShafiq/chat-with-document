import { useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { DocumentPreviewPane } from "#/components/documents/document-preview-pane";
import type { PreviewableDocument } from "#/lib/documents/previewable-document";

export type DocumentPreviewModalProps = {
  open: boolean;
  document: PreviewableDocument | null;
  /** 0-based page from citation / deep-link. */
  initialPageIndex?: number;
  /** Remount key so same doc + different page reloads cleanly. */
  instanceKey?: string | number;
  onClose: () => void;
};

/**
 * Modal document preview — portaled to body + native showModal() so it always
 * sits above chat chrome / overflow containers.
 */
export function DocumentPreviewModal({
  open,
  document: previewDoc,
  initialPageIndex = 0,
  instanceKey,
  onClose,
}: DocumentPreviewModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const visible = open && previewDoc != null;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (visible) {
      if (!dialog.open) {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute("open", "");
        }
      }
      return;
    }

    if (dialog.open) {
      dialog.close();
    }
  }, [visible, instanceKey]);

  if (typeof window === "undefined") return null;
  // Only mount while open so showModal runs on a fresh node each time.
  if (!visible || !previewDoc) return null;

  return createPortal(
    <dialog
      ref={dialogRef}
      className="document-preview-dialog m-auto h-[min(80dvh,44rem)] max-h-[min(90dvh,52rem)] w-[min(100%-1.5rem,42rem)] overflow-hidden rounded-2xl border border-hairline bg-canvas-elevated p-0 text-text shadow-[0_24px_64px_-16px_rgba(0,0,0,0.7)] animate-scale-in"
      style={{ transformOrigin: "center center" }}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
    >
      <h2 id={titleId} className="sr-only">
        {previewDoc.filename}
      </h2>

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <DocumentPreviewPane
          key={instanceKey ?? `${previewDoc.id}:${initialPageIndex}`}
          document={previewDoc}
          initialPageIndex={initialPageIndex}
          showHeader
          onClose={onClose}
        />
      </div>
    </dialog>,
    window.document.body,
  );
}

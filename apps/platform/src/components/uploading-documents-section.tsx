import type { UIAttachment } from "@anvia/react";
import { Composer, useComposer } from "@anvia/react-ui";
import type { IngestionItem } from "#/components/chat/session-documents-panel";
import { CollapsibleDocumentSection } from "#/components/collapsible-document-section";
import { ComposerAttachmentChip } from "#/components/composer-attachment";
import { IngestionStatusPill } from "#/components/ingestion-status-pill";

/** @deprecated Prefer SessionDocumentsPanel — kept for reference. */
export function UploadingDocumentsSection({
  ingestionItems,
}: {
  ingestionItems: IngestionItem[];
}) {
  const composer = useComposer();
  const hasAttachments = composer.attachments.length > 0;
  const hasIngestion = ingestionItems.length > 0;

  if (!hasAttachments && !hasIngestion) return null;

  return (
    <CollapsibleDocumentSection title="Attachments">
      <div className="doc-chip-scroll flex flex-nowrap gap-2 overflow-x-auto overscroll-x-contain pb-0.5">
        {hasIngestion
          ? ingestionItems.map((item) => (
              <IngestionStatusPill
                key={item.id}
                filename={item.filename}
                status={item.status}
              />
            ))
          : null}
        {hasAttachments ? (
          <Composer.Attachments keepMounted className="contents">
            {(attachment: UIAttachment) => (
              <ComposerAttachmentChip attachment={attachment} />
            )}
          </Composer.Attachments>
        ) : null}
      </div>
    </CollapsibleDocumentSection>
  );
}

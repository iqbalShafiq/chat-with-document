import type { UIAttachment } from "@anvia/react";
import { Composer, useComposer } from "@anvia/react-ui";
import type { DocumentStatus } from "#/lib/api";
import { CollapsibleDocumentSection } from "#/components/collapsible-document-section";
import { ComposerAttachmentChip } from "#/components/composer-attachment";
import { IngestionStatusPill } from "#/components/ingestion-status-pill";

export function UploadingDocumentsSection({
  ingestionItems,
}: {
  ingestionItems: Array<{ filename: string; status: DocumentStatus }>;
}) {
  const composer = useComposer();
  const hasAttachments = composer.attachments.length > 0;
  const hasIngestion = ingestionItems.length > 0;

  if (!hasAttachments && !hasIngestion) return null;

  return (
    <CollapsibleDocumentSection title="Attachments">
      <div className="doc-chip-scroll flex flex-nowrap gap-2 overflow-x-auto overscroll-x-contain pb-0.5">
        {hasIngestion ? (
          ingestionItems.map((item) => (
            <IngestionStatusPill
              key={`ingest-${item.filename}-${item.status}`}
              filename={item.filename}
              status={item.status}
            />
          ))
        ) : (
          <Composer.Attachments keepMounted className="contents">
            {(attachment: UIAttachment) => (
              <ComposerAttachmentChip attachment={attachment} />
            )}
          </Composer.Attachments>
        )}
      </div>
    </CollapsibleDocumentSection>
  );
}

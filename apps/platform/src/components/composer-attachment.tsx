import type { UIAttachment } from "@anvia/react";
import { useComposer } from "@anvia/react-ui";
import { FileText, X } from "lucide-react";

export function ComposerAttachmentChip({
  attachment,
}: {
  attachment: UIAttachment;
}) {
  const composer = useComposer();
  const name = attachment.name ?? "Document";

  return (
    <div className="inline-flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700">
      <FileText className="size-4 shrink-0 text-emerald-700" strokeWidth={1.75} />
      <span className="truncate font-medium">{name}</span>
      <button
        type="button"
        aria-label={`Remove ${name}`}
        onClick={() => composer.removeAttachment(attachment.id)}
        className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-zinc-400 transition hover:bg-white hover:text-zinc-700"
      >
        <X className="size-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

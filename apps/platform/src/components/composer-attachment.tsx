import type { UIAttachment } from "@anvia/react";
import { useComposer } from "@anvia/react-ui";
import { FileText, X } from "lucide-react";
import { useRef, useState } from "react";

const EXIT_MS = 180;

export function ComposerAttachmentChip({
  attachment,
  className = "",
}: {
  attachment: UIAttachment;
  className?: string;
}) {
  const composer = useComposer();
  const name = attachment.name ?? "Document";
  const [leaving, setLeaving] = useState(false);
  const exitingRef = useRef(false);

  const handleRemove = () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setLeaving(true);

    window.setTimeout(() => {
      composer.removeAttachment(attachment.id);
    }, EXIT_MS);
  };

  return (
    <div
      className={`grid w-full min-w-0 transition-[grid-template-rows,opacity] ease-out motion-reduce:transition-none ${
        leaving
          ? "pointer-events-none grid-rows-[0fr] opacity-0"
          : "grid-rows-[1fr] opacity-100"
      } ${className}`}
      style={{ transitionDuration: `${EXIT_MS}ms` }}
    >
      <div className="min-h-0 w-full min-w-0 overflow-hidden">
        <div
          className={`glass-pane flex min-h-10 w-full min-w-0 items-center gap-2 rounded-xl px-3 py-2 text-xs text-text transition-[opacity,transform] ease-out motion-reduce:transition-none ${
            leaving ? "scale-95 opacity-0" : "scale-100 opacity-100"
          }`}
          style={{ transitionDuration: `${EXIT_MS}ms` }}
        >
          <FileText
            className="size-4 shrink-0 text-accent"
            strokeWidth={1.75}
          />
          <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          <button
            type="button"
            aria-label={`Remove ${name}`}
            onClick={handleRemove}
            disabled={leaving}
            className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-faint transition hover:bg-white/[0.06] hover:text-text disabled:cursor-default"
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

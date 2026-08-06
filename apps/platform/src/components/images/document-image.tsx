import { useCallback } from "react";
import { useImagePreview } from "#/components/images/image-preview";
import { useDocumentImage } from "#/components/images/use-document-image";

export { useDocumentImage };

export function DocumentImage({
  src,
  alt = "",
  className,
}: {
  src: string;
  alt?: string;
  className?: string;
}) {
  const { open } = useImagePreview();
  const { internal, displaySrc, state, retry } = useDocumentImage(src);

  const openPreview = useCallback(() => {
    open({ src, alt });
  }, [open, src, alt]);

  if (internal && state === "loading") {
    return (
      <div className="my-3 flex flex-col gap-1.5">
        <div className="skeleton-shimmer h-40 w-full max-w-sm rounded-lg" />
        <span className="text-[11px] text-text-faint">Loading image…</span>
      </div>
    );
  }

  if (internal && state === "error") {
    return (
      <div className="my-3 flex items-center gap-2 rounded-lg border border-danger/20 bg-danger-soft px-2.5 py-2">
        <span className="text-[11px] text-danger">Image failed to load.</span>
        <button
          type="button"
          onClick={retry}
          className="rounded-md border border-hairline bg-surface px-1.5 py-0.5 text-[11px] font-medium text-text transition hover:bg-surface-elevated"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={openPreview}
      aria-label={alt ? `View image: ${alt}` : "View image"}
      className="my-3 block max-w-full cursor-zoom-in"
    >
      <img
        src={displaySrc}
        alt={alt}
        loading="lazy"
        className={
          className ??
          "max-h-72 max-w-full rounded-lg border border-white/[0.06] object-contain"
        }
      />
    </button>
  );
}

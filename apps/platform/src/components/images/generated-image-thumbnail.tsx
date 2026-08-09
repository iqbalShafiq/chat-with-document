import { useEffect } from "react";
import { Pin, PinOff } from "lucide-react";
import { useImagePreview } from "#/components/images/image-preview";
import { useGeneratedImage } from "#/components/images/use-generated-image";
import type { GeneratedImageItem } from "#/lib/chat/generated-images";

/**
 * Square thumbnail tile for a stored generated image — shared by the session
 * rail, the gallery modal, and inline message strips. Hover shows the prompt;
 * nOfTotal renders a badge.
 *
 * `onSrcReady` reports the loaded blob URL (used by strips to build a viewer
 * batch) and `onOpen` overrides the default single-image preview. When
 * `pinned`/`onTogglePin` are provided a pin button overlays the tile so the
 * image can be added to (or removed from) the session's active image context.
 */
export function GeneratedImageThumbnail({
  image,
  onSrcReady,
  onOpen,
  pinned,
  onTogglePin,
}: {
  image: GeneratedImageItem;
  onSrcReady?: (src: string) => void;
  onOpen?: () => void;
  pinned?: boolean;
  onTogglePin?: () => void;
}) {
  const { open } = useImagePreview();
  const { displaySrc, state, retry } = useGeneratedImage(image.id);

  useEffect(() => {
    if (state === "ready" && displaySrc) onSrcReady?.(displaySrc);
  }, [state, displaySrc, onSrcReady]);

  if (state === "loading" || !displaySrc) {
    return <div className="skeleton-shimmer aspect-square w-full rounded-lg" />;
  }

  if (state === "error") {
    return (
      <button
        type="button"
        onClick={retry}
        title="Image failed to load — retry"
        className="flex aspect-square w-full cursor-pointer items-center justify-center rounded-lg border border-danger/25 bg-danger-soft text-[10px] text-danger"
      >
        Retry
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => {
        if (onOpen) {
          onOpen();
        } else {
          open({
            src: displaySrc,
            alt: image.prompt || "Generated image",
            image,
          });
        }
      }}
      title={image.prompt || "View generated image"}
      className="group/thumb relative block w-full cursor-zoom-in overflow-hidden rounded-lg border border-white/[0.06] transition hover:border-white/[0.14] active:scale-[0.98]"
    >
      <img
        src={displaySrc}
        alt={image.prompt || "Generated image"}
        loading="lazy"
        className="aspect-square w-full object-cover"
      />
      {onTogglePin ? (
        <span
          role="button"
          tabIndex={0}
          aria-label={
            pinned ? "Remove image from context" : "Add image as context"
          }
          title={pinned ? "Remove from context" : "Add as context"}
          onClick={(event) => {
            event.stopPropagation();
            onTogglePin();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              event.stopPropagation();
              onTogglePin();
            }
          }}
          className={`absolute right-1 top-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-md backdrop-blur-sm transition duration-150 active:scale-[0.92] ${
            pinned
              ? "bg-accent text-canvas opacity-100"
              : "bg-black/60 text-white/85 opacity-0 group-hover/thumb:opacity-100 hover:bg-black/75 hover:text-white"
          }`}
        >
          {pinned ? (
            <Pin className="size-3" strokeWidth={2} />
          ) : (
            <PinOff className="size-3" strokeWidth={2} />
          )}
        </span>
      ) : null}
      {image.nOfTotal ? (
        <span className="absolute right-1 top-1 rounded-md bg-black/60 px-1 py-0.5 text-[9px] font-semibold leading-none text-white/90 backdrop-blur-sm">
          {image.nOfTotal}
        </span>
      ) : null}
      {image.prompt ? (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-3 opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/thumb:opacity-100">
          <span className="text-left text-[10px] leading-tight text-white/85 line-clamp-2">
            {image.prompt}
          </span>
        </span>
      ) : null}
    </button>
  );
}

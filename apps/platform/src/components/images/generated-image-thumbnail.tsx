import { useImagePreview } from "#/components/images/image-preview";
import { useGeneratedImage } from "#/components/images/use-generated-image";
import type { GeneratedImageItem } from "#/lib/chat/generated-images";

/**
 * Square thumbnail tile for a stored generated image — shared by the session
 * rail and the gallery modal. Hover shows the prompt; nOfTotal renders a badge.
 */
export function GeneratedImageThumbnail({
  image,
}: {
  image: GeneratedImageItem;
}) {
  const { open } = useImagePreview();
  const { displaySrc, state, retry } = useGeneratedImage(image.id);

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
      onClick={() =>
        open({ src: displaySrc, alt: image.prompt || "Generated image" })
      }
      title={image.prompt || "View generated image"}
      className="group/thumb relative block w-full cursor-zoom-in overflow-hidden rounded-lg border border-white/[0.06] transition hover:border-white/[0.14] active:scale-[0.98]"
    >
      <img
        src={displaySrc}
        alt={image.prompt || "Generated image"}
        loading="lazy"
        className="aspect-square w-full object-cover"
      />
      {image.nOfTotal ? (
        <span className="absolute right-1 top-1 rounded-md bg-black/60 px-1 py-0.5 text-[9px] font-semibold leading-none text-white/90 backdrop-blur-sm">
          {image.nOfTotal}
        </span>
      ) : null}
      {image.prompt ? (
        <span className="pointer-events-none absolute inset-x-0 bottom-0 line-clamp-2 bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-3 text-left text-[10px] leading-tight text-white/85 opacity-0 transition-opacity duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/thumb:opacity-100">
          {image.prompt}
        </span>
      ) : null}
    </button>
  );
}

import { useCallback, useRef } from "react";
import { useImagePreview, type ImagePreviewInput } from "#/components/images/image-preview";
import { GeneratedImageThumbnail } from "#/components/images/generated-image-thumbnail";
import type { GeneratedImageItem } from "#/lib/chat/generated-images";

/**
 * Horizontal scrollable strip of generated images that belong to the same
 * generation run (n > 1) and sit consecutively in the message with no text
 * between them. Clicking any tile opens the viewer on the whole batch so the
 * user can step next/previous within that run.
 */
export function GeneratedImageStrip({
  images,
}: {
  images: GeneratedImageItem[];
}) {
  const { open } = useImagePreview();
  const srcsRef = useRef<Record<string, string>>({});

  const openAt = useCallback(
    (index: number) => {
      const srcs = srcsRef.current;
      const batch: ImagePreviewInput[] = [];
      for (const image of images) {
        const src = srcs[image.id];
        if (src) batch.push({ src, alt: image.prompt || "Generated image", image });
      }
      if (batch.length === 0) return;
      const relative = images.slice(0, index + 1).filter((image) => srcs[image.id]).length - 1;
      open({ images: batch, index: Math.max(relative, 0) });
    },
    [images, open],
  );

  return (
    <div
      className="chat-scroll-x mt-2 flex max-w-full gap-2 overflow-x-auto pb-1.5"
      role="list"
      aria-label="Generated images"
    >
      {images.map((image, index) => (
        <div key={image.id} className="w-36 shrink-0" role="listitem">
          <GeneratedImageThumbnail
            image={image}
            onSrcReady={(src) => {
              srcsRef.current[image.id] = src;
            }}
            onOpen={() => openAt(index)}
          />
        </div>
      ))}
    </div>
  );
}

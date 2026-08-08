import { useCallback, useEffect, useState } from "react";
import { fetchImageBytes } from "#/lib/api";

type LoadState = "loading" | "ready" | "error";

/**
 * Loads a stored generated image (by id) through an authenticated
 * `fetchImageBytes` → blob URL, since plain <img> cannot send the session
 * cookie cross-origin. Mirrors useDocumentImage for the images rail/gallery.
 */
export function useGeneratedImage(imageId: string) {
  const [state, setState] = useState<LoadState>("loading");
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!imageId) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    setState("loading");

    fetchImageBytes(imageId)
      .then(({ blob }) => {
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) setState("error");
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [imageId, retryKey]);

  const retry = useCallback(() => {
    setObjectUrl(null);
    setState("loading");
    setRetryKey((current) => current + 1);
  }, []);

  return {
    displaySrc: objectUrl ?? undefined,
    state,
    retry,
  };
}

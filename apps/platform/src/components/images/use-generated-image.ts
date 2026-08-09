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
    if (!imageId) {
      setState("error");
      setObjectUrl(null);
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    // Drop any previous object URL from state immediately so a remount /
    // id-switch never paints a revoked blob (which shows as alt-text only).
    setState("loading");
    setObjectUrl(null);

    fetchImageBytes(imageId)
      .then(({ blob, mediaType }) => {
        if (cancelled) return;
        // Some browsers ignore untyped blobs for <img>; prefer the API
        // Content-Type when the Response didn't carry one.
        const typed =
          blob.type && blob.type !== "application/octet-stream"
            ? blob
            : new Blob([blob], { type: mediaType || "image/png" });
        createdUrl = URL.createObjectURL(typed);
        setObjectUrl(createdUrl);
        setState("ready");
      })
      .catch(() => {
        if (!cancelled) {
          setObjectUrl(null);
          setState("error");
        }
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

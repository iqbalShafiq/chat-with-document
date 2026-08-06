import { useCallback, useEffect, useState } from "react";
import { isDocumentImagePath, resolveDocumentImageUrl } from "#/lib/api";

type LoadState = "loading" | "ready" | "error";

/**
 * Loads app-internal document images (relative `/api/documents/...` or
 * `${API_BASE}/api/documents/...`) through an authenticated fetch → blob URL,
 * since plain <img> cannot send the session cookie cross-origin. Non-internal
 * sources (data:/http:) pass through untouched.
 *
 * Shared by the inline DocumentImage and the ImagePreviewProvider lightbox —
 * kept in its own module so both can import it without a circular dependency.
 */
export function useDocumentImage(src: string) {
  const internal = isDocumentImagePath(src);
  const [state, setState] = useState<LoadState>(() =>
    internal ? "loading" : "ready",
  );
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    if (!internal) return;
    let cancelled = false;
    let createdUrl: string | null = null;
    setState("loading");

    fetch(resolveDocumentImageUrl(src), { credentials: "include" })
      .then((response) => {
        if (!response.ok) throw new Error(`Image fetch failed: ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
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
  }, [src, internal, retryKey]);

  const retry = useCallback(() => {
    setObjectUrl(null);
    setState("loading");
    setRetryKey((current) => current + 1);
  }, []);

  return {
    internal,
    displaySrc: internal ? (objectUrl ?? src) : src,
    state,
    retry,
  };
}

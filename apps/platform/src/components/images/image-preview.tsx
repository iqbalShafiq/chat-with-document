import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { useDocumentImage } from "#/components/images/use-document-image";

type ImagePreviewInput = { src: string; alt?: string };
type ImagePreviewContextValue = { open: (input: ImagePreviewInput) => void };

const ImagePreviewContext = createContext<ImagePreviewContextValue | null>(null);

export function useImagePreview(): ImagePreviewContextValue {
  const context = useContext(ImagePreviewContext);
  if (!context) {
    throw new Error("useImagePreview must be used within ImagePreviewProvider");
  }
  return context;
}

const MIN_SCALE = 1;
const MAX_SCALE = 5;
const ZOOM_STEP = 1.5;

export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ImagePreviewInput | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const titleId = useId();
  // Internal document URLs need an authenticated fetch (plain <img> cannot
  // send the session cookie cross-origin) — same path as inline DocumentImage.
  const { internal, displaySrc, state, retry } = useDocumentImage(
    current?.src ?? "",
  );

  const resetView = useCallback(() => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const open = useCallback(
    (input: ImagePreviewInput) => {
      setCurrent(input);
      resetView();
    },
    [resetView],
  );

  const close = useCallback(() => {
    dialogRef.current?.close();
    setCurrent(null);
    resetView();
  }, [resetView]);

  const zoomBy = useCallback((factor: number) => {
    setScale((currentScale) =>
      Math.min(MAX_SCALE, Math.max(MIN_SCALE, currentScale * factor)),
    );
  }, []);

  const clampPan = useCallback(
    (x: number, y: number, currentScale: number) => {
      const container = containerRef.current;
      if (!container || currentScale <= 1) return { x: 0, y: 0 };
      const maxX = ((currentScale - 1) * container.clientWidth) / 2;
      const maxY = ((currentScale - 1) * container.clientHeight) / 2;
      return {
        x: Math.min(maxX, Math.max(-maxX, x)),
        y: Math.min(maxY, Math.max(-maxY, y)),
      };
    },
    [],
  );

  useEffect(() => {
    if (scale <= 1) setPan({ x: 0, y: 0 });
  }, [scale]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (scale <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pan.x,
      originY: pan.y,
    };
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan(() =>
      clampPan(
        drag.originX + (event.clientX - drag.startX),
        drag.originY + (event.clientY - drag.startY),
        scale,
      ),
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
  };

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (current) {
      if (!dialog.open) {
        try {
          dialog.showModal();
        } catch {
          dialog.setAttribute("open", "");
        }
      }
      return;
    }
    if (dialog.open) dialog.close();
  }, [current]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!current) return;
      if (event.repeat) return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomBy(ZOOM_STEP);
      } else if (event.key === "-") {
        event.preventDefault();
        zoomBy(1 / ZOOM_STEP);
      } else if (event.key === "0") {
        resetView();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, zoomBy, resetView]);

  if (typeof window === "undefined") return null;

  return (
    <ImagePreviewContext.Provider value={{ open }}>
      {children}
      {current
        ? createPortal(
            <dialog
              ref={dialogRef}
              aria-labelledby={titleId}
              aria-modal="true"
              className="m-auto flex h-full max-h-[92dvh] w-full max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-hairline bg-canvas-elevated/95 p-0 text-text backdrop-blur-xl shadow-[0_24px_64px_-16px_rgba(0,0,0,0.8)] animate-scale-in motion-reduce:animate-none"
              onCancel={(event) => {
                event.preventDefault();
                close();
              }}
              onClick={(event) => {
                if (event.target === dialogRef.current) close();
              }}
            >
              <h2 id={titleId} className="sr-only">
                {current.alt || "Image preview"}
              </h2>

              <div
                ref={containerRef}
                className="relative flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden"
                onWheel={(event) => {
                  event.preventDefault();
                  zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
                }}
                onDoubleClick={() => {
                  zoomBy(scale >= 2 ? 1 / ZOOM_STEP : ZOOM_STEP);
                }}
                onPointerDown={startDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
              >
                {internal && state === "loading" ? (
                  <div className="flex flex-col items-center gap-2">
                    <div className="skeleton-shimmer size-40 rounded-xl" />
                    <span className="text-[11px] text-text-faint">
                      Loading image…
                    </span>
                  </div>
                ) : internal && state === "error" ? (
                  <div className="flex flex-col items-center gap-2.5">
                    <p className="text-xs text-danger" role="alert">
                      Image failed to load.
                    </p>
                    <button
                      type="button"
                      onClick={retry}
                      className="inline-flex cursor-pointer items-center rounded-lg border border-hairline bg-surface px-3 py-1.5 text-[11px] font-medium text-text transition hover:bg-surface-elevated active:scale-[0.97]"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <img
                    src={displaySrc}
                    alt={current.alt ?? "Document image"}
                    draggable={false}
                    className="max-h-full max-w-full object-contain transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
                    style={{
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                    }}
                  />
                )}
              </div>

              <div className="flex shrink-0 items-center justify-end gap-1 border-t border-white/[0.06] px-3 py-2.5">
                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={() => zoomBy(1 / ZOOM_STEP)}
                  className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.96] disabled:opacity-40"
                  disabled={scale <= MIN_SCALE}
                >
                  <Minus className="size-4" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label="Reset zoom"
                  onClick={resetView}
                  className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.96] disabled:opacity-40"
                  disabled={scale <= MIN_SCALE}
                >
                  <RotateCcw className="size-4" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => zoomBy(ZOOM_STEP)}
                  className="inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.96] disabled:opacity-40"
                  disabled={scale >= MAX_SCALE}
                >
                  <Plus className="size-4" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label="Close image preview"
                  onClick={close}
                  className="ml-1 inline-flex size-8 cursor-pointer items-center justify-center rounded-lg text-text-muted transition hover:bg-white/10 hover:text-text active:scale-[0.96]"
                >
                  <X className="size-4" strokeWidth={1.75} />
                </button>
              </div>
            </dialog>,
            window.document.body,
          )
        : null}
    </ImagePreviewContext.Provider>
  );
}

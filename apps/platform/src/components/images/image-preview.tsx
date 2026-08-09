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
import {
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  RotateCcw,
  X,
} from "lucide-react";
import { useDocumentImage } from "#/components/images/use-document-image";

export type ImagePreviewInput = { src: string; alt?: string };
type ImagePreviewCollection = {
  images: ImagePreviewInput[];
  /** Index of the image to show first (default 0). */
  index?: number;
};
type ImagePreviewOpenInput = ImagePreviewInput | ImagePreviewCollection;
type ImagePreviewContextValue = { open: (input: ImagePreviewOpenInput) => void };

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

/**
 * Full-screen image viewer rendered as a native dialog with a frosted-glass
 * backdrop — no container panel: the image floats directly on the glass.
 *
 * Behavior & accessibility:
 * - `<dialog>.showModal()` gives focus trapping + Esc handling for free.
 * - Zoom via wheel, double-click, toolbar buttons, or + / − / 0 keys.
 * - Pan (when zoomed) via pointer drag; clicks on the backdrop close.
 * - `aria-modal` + `aria-labelledby`; all controls have aria-labels and
 *   disabled states; motion respects `prefers-reduced-motion` (CSS).
 */
export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  const [collection, setCollection] = useState<ImagePreviewInput[] | null>(null);
  const [index, setIndex] = useState(0);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const titleId = useId();
  const current = collection?.[index] ?? null;
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
    (input: ImagePreviewOpenInput) => {
      if ("images" in input) {
        setCollection(input.images);
        setIndex(Math.min(Math.max(input.index ?? 0, 0), input.images.length - 1));
      } else {
        setCollection([input]);
        setIndex(0);
      }
      resetView();
    },
    [resetView],
  );

  const close = useCallback(() => {
    dialogRef.current?.close();
    setCollection(null);
    setIndex(0);
    resetView();
  }, [resetView]);

  const goTo = useCallback(
    (nextIndex: number) => {
      setIndex((currentIndex) => {
        const length = collection?.length ?? 1;
        const clamped = Math.min(Math.max(nextIndex, 0), length - 1);
        if (clamped === currentIndex) return currentIndex;
        resetView();
        return clamped;
      });
    },
    [collection, resetView],
  );

  const zoomBy = useCallback((factor: number) => {
    setScale((currentScale) =>
      Math.min(MAX_SCALE, Math.max(MIN_SCALE, currentScale * factor)),
    );
  }, []);

  const clampPan = useCallback(
    (x: number, y: number, currentScale: number) => {
      const stage = stageRef.current;
      if (!stage || currentScale <= 1) return { x: 0, y: 0 };
      const maxX = ((currentScale - 1) * stage.clientWidth) / 2;
      const maxY = ((currentScale - 1) * stage.clientHeight) / 2;
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
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goTo(index + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        goTo(index - 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [current, index, zoomBy, resetView, goTo]);

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
              className="image-viewer m-auto flex items-center justify-center p-0 text-text"
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
                ref={stageRef}
                className="relative flex h-full w-full touch-none select-none items-center justify-center overflow-hidden p-8"
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
                onClick={(event) => {
                  // Click on the glass area around the image closes the viewer.
                  if (event.target === stageRef.current) close();
                }}
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
                      className="glass inline-flex cursor-pointer items-center rounded-lg px-3 py-1.5 text-[11px] font-medium text-text transition hover:bg-white/10 active:scale-[0.97]"
                    >
                      Retry
                    </button>
                  </div>
                ) : (
                  <img
                    src={displaySrc}
                    alt={current.alt ?? "Document image"}
                    draggable={false}
                    className="max-h-full max-w-full object-contain drop-shadow-[0_24px_48px_rgba(0,0,0,0.55)] transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none"
                    style={{
                      transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
                    }}
                  />
                )}
              </div>

              {/* Floating glass controls — no toolbar container, they sit on
                  the frosted backdrop next to the image. */}
              <div className="pointer-events-none absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-xl p-1">
                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={() => zoomBy(1 / ZOOM_STEP)}
                  className="glass pointer-events-auto inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                  disabled={scale <= MIN_SCALE}
                >
                  <Minus className="size-4" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label="Reset zoom"
                  onClick={resetView}
                  className="glass pointer-events-auto inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                  disabled={scale <= MIN_SCALE}
                >
                  <RotateCcw className="size-4" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => zoomBy(ZOOM_STEP)}
                  className="glass pointer-events-auto inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                  disabled={scale >= MAX_SCALE}
                >
                  <Plus className="size-4" strokeWidth={1.75} />
                </button>
                {collection && collection.length > 1 ? (
                  <span className="pointer-events-auto ml-1.5 rounded-lg px-1 text-[11px] font-medium tabular-nums text-text-faint">
                    {index + 1} / {collection.length}
                  </span>
                ) : null}
              </div>

              {collection && collection.length > 1 ? (
                <>
                  <div className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2">
                    <button
                      type="button"
                      aria-label="Previous image"
                      onClick={() => goTo(index - 1)}
                      className="glass pointer-events-auto inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                      disabled={index <= 0}
                    >
                      <ChevronLeft className="size-4" strokeWidth={1.75} />
                    </button>
                  </div>
                  <div className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2">
                    <button
                      type="button"
                      aria-label="Next image"
                      onClick={() => goTo(index + 1)}
                      className="glass pointer-events-auto inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                      disabled={index >= collection.length - 1}
                    >
                      <ChevronRight className="size-4" strokeWidth={1.75} />
                    </button>
                  </div>
                </>
              ) : null}

              <div className="pointer-events-none absolute right-4 top-4">
                <button
                  type="button"
                  aria-label="Close image preview"
                  onClick={close}
                  className="glass pointer-events-auto inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-text-muted transition duration-150 hover:bg-white/12 hover:text-text active:scale-[0.95] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
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

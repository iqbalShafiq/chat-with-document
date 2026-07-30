import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/**
 * Custom vertical scrollbar with independent top/bottom insets.
 * Pairs with a scroll container that hides its native scrollbar so content
 * can extend under chrome while the thumb stays between the insets.
 */
export function InsetScrollbar({
  scrollRef,
  top,
  bottom,
  className = "",
}: {
  scrollRef: RefObject<HTMLElement | null>;
  /** CSS length for track offset from top of the positioning parent */
  top: string;
  /** CSS length for track offset from bottom of the positioning parent */
  bottom: string;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragOffset = useRef(0);
  const [metrics, setMetrics] = useState({
    thumbH: 0,
    thumbTop: 0,
    visible: false,
  });

  const sync = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, scrollHeight, clientHeight } = el;
    const canScroll = scrollHeight > clientHeight + 1;
    if (!canScroll) {
      setMetrics({ thumbH: 0, thumbTop: 0, visible: false });
      return;
    }
    const trackH = trackRef.current?.clientHeight ?? clientHeight;
    const ratio = clientHeight / scrollHeight;
    const thumbH = Math.max(28, Math.round(trackH * ratio));
    const maxTop = Math.max(0, trackH - thumbH);
    const maxScroll = scrollHeight - clientHeight;
    const thumbTop =
      maxScroll <= 0 ? 0 : Math.round((scrollTop / maxScroll) * maxTop);
    setMetrics({ thumbH, thumbTop, visible: true });
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    sync();
    el.addEventListener("scroll", sync, { passive: true });
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", sync);
      ro.disconnect();
    };
  }, [scrollRef, sync]);

  const scrollFromPointer = (clientY: number, offsetY: number) => {
    const el = scrollRef.current;
    const track = trackRef.current;
    if (!el || !track) return;
    const rect = track.getBoundingClientRect();
    const trackH = rect.height;
    const thumbH = metrics.thumbH || 28;
    const maxTop = Math.max(0, trackH - thumbH);
    const y = clientY - rect.top - offsetY;
    const thumbTop = Math.min(maxTop, Math.max(0, y));
    const maxScroll = el.scrollHeight - el.clientHeight;
    el.scrollTop = maxTop <= 0 ? 0 : (thumbTop / maxTop) * maxScroll;
  };

  const onThumbPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    dragging.current = true;
    const thumbTop = metrics.thumbTop;
    const rect = trackRef.current?.getBoundingClientRect();
    dragOffset.current = rect ? e.clientY - rect.top - thumbTop : 0;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onThumbPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    scrollFromPointer(e.clientY, dragOffset.current);
  };

  const onThumbPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const onTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const thumbH = metrics.thumbH || 28;
    scrollFromPointer(e.clientY, thumbH / 2);
  };

  if (!metrics.visible) return null;

  const style: CSSProperties = {
    top,
    bottom,
  };

  return (
    <div
      ref={trackRef}
      className={`pointer-events-auto absolute right-1.5 z-30 w-1 ${className}`}
      style={style}
      onPointerDown={onTrackPointerDown}
      aria-hidden
    >
      <div
        className="absolute left-0 right-0 cursor-pointer rounded-full bg-white/[0.08] transition-colors hover:bg-white/[0.14] active:bg-white/[0.18]"
        style={{
          height: metrics.thumbH,
          transform: `translateY(${metrics.thumbTop}px)`,
        }}
        onPointerDown={onThumbPointerDown}
        onPointerMove={onThumbPointerMove}
        onPointerUp={onThumbPointerUp}
        onPointerCancel={onThumbPointerUp}
      />
    </div>
  );
}

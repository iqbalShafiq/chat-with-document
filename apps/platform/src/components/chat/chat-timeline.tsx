import type { UIMessage } from "@anvia/react";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import { getMessageTimestamp } from "#/lib/chat/group-messages-by-day";
import {
  calendarDayKey,
  formatMessageDateLabel,
  formatMessageDateTime,
} from "#/lib/chat/message-time";

export type TimelineDayPoint = {
  messageId: string;
  iso: string;
  label: string;
  title: string;
};

/** App bar height (h-14) + same 24px gap as chat content paddingTop. */
const TOP_BAR_PX = 56;
const CONTENT_TOP_GAP_PX = 24;

/**
 * Day anchors: first *user* message of each calendar day (for segment bounds).
 */
export function buildTimelineDayPoints(messages: UIMessage[]): TimelineDayPoint[] {
  const points: TimelineDayPoint[] = [];
  let previousUserDayKey: string | null = null;

  for (const message of messages) {
    if (message.role !== "user") continue;
    const iso = getMessageTimestamp(message);
    if (!iso) continue;
    const dayKey = calendarDayKey(iso);
    if (!dayKey || dayKey === previousUserDayKey) continue;

    const label = formatMessageDateLabel(iso);
    if (!label) continue;

    previousUserDayKey = dayKey;
    points.push({
      messageId: message.id,
      iso,
      label,
      title: formatMessageDateTime(iso) ?? label,
    });
  }

  return points;
}

/** Matches Thread.ScrollToBottom ("Latest") pill sizing & chrome. */
const DATE_CARD_CLASS =
  "glass inline-flex min-h-10 items-center rounded-full px-4 text-sm font-medium text-text-muted shadow-[0_8px_24px_-12px_rgba(0,0,0,0.55)]";

function resolveUserBubble(
  scroller: HTMLElement,
  messageId: string,
): HTMLElement | null {
  const row = scroller.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(messageId)}"]`,
  );
  if (!row) return null;

  return (
    row.querySelector<HTMLElement>("[data-anvia-message-content]") ??
    row.querySelector<HTMLElement>(".glass-bubble") ??
    row.querySelector<HTMLElement>("[data-anvia-message]") ??
    row
  );
}

function resolveMessageRow(
  scroller: HTMLElement,
  messageId: string,
): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(messageId)}"]`,
  );
}

/** Visible height of [segStart, segEnd] inside [viewTop, viewBottom]. */
function visibleOverlap(
  segStart: number,
  segEnd: number,
  viewTop: number,
  viewBottom: number,
): number {
  return Math.max(
    0,
    Math.min(segEnd, viewBottom) - Math.max(segStart, viewTop),
  );
}

/**
 * Pick the day whose messages occupy the largest vertical share of the
 * visible reading band. Ties prefer the later day (more recently entered).
 */
function pickMajorityDayIndex(
  scroller: HTMLElement,
  points: TimelineDayPoint[],
  viewTop: number,
  viewBottom: number,
): number {
  if (points.length === 0) return 0;

  let bestIndex = 0;
  let bestVisible = -1;

  for (let i = 0; i < points.length; i += 1) {
    const startBubble = resolveUserBubble(scroller, points[i]!.messageId);
    if (!startBubble) continue;

    const segStart = startBubble.getBoundingClientRect().top;

    let segEnd: number;
    if (i + 1 < points.length) {
      const nextBubble = resolveUserBubble(scroller, points[i + 1]!.messageId);
      const nextRow = resolveMessageRow(scroller, points[i + 1]!.messageId);
      segEnd =
        nextBubble?.getBoundingClientRect().top ??
        nextRow?.getBoundingClientRect().top ??
        viewBottom;
    } else {
      // Last day: until bottom of last message row in the thread.
      const messagesRoot = scroller.querySelector<HTMLElement>(
        "[data-anvia-thread-messages]",
      );
      const lastRow = messagesRoot?.lastElementChild as HTMLElement | null;
      segEnd =
        lastRow?.getBoundingClientRect().bottom ??
        scroller.getBoundingClientRect().bottom;
    }

    const visible = visibleOverlap(segStart, segEnd, viewTop, viewBottom);
    // Strict > keeps earlier day on equal split; >= prefers later day when
    // the viewport has shifted more into the next section.
    if (visible >= bestVisible) {
      bestVisible = visible;
      bestIndex = i;
    }
  }

  return bestIndex;
}

type ChatTimelineProps = {
  scrollRef: RefObject<HTMLElement | null>;
  containerRef: RefObject<HTMLElement | null>;
  messages: UIMessage[];
  contentMaxPx?: number;
  scrollTickRef?: MutableRefObject<(() => void) | null>;
};

/**
 * Single floating date card — fixed under the app bar (same 24px gap as the
 * first chat bubble). Label = day that currently fills the most of the
 * visible viewport.
 */
export function ChatTimeline({
  scrollRef,
  containerRef,
  messages,
  contentMaxPx = 760,
  scrollTickRef,
}: ChatTimelineProps) {
  const dayPoints = useMemo(
    () => buildTimelineDayPoints(messages),
    [messages],
  );

  const [layout, setLayout] = useState({
    left: 0,
    top: 0,
    visible: false,
    activeIndex: 0,
  });

  const rafRef = useRef<number | null>(null);
  const dayPointsRef = useRef(dayPoints);
  dayPointsRef.current = dayPoints;

  const recompute = useCallback(() => {
    const scroller = scrollRef.current;
    const container = containerRef.current;
    const points = dayPointsRef.current;

    if (!scroller || !container || points.length === 0) {
      setLayout((prev) =>
        prev.visible
          ? { left: 0, top: 0, visible: false, activeIndex: 0 }
          : prev,
      );
      return;
    }

    const scrollRect = scroller.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    const freeLeft = Math.max(0, (scrollRect.width - contentMaxPx) / 2);
    if (freeLeft < 72) {
      setLayout((prev) =>
        prev.visible
          ? { left: 0, top: 0, visible: false, activeIndex: 0 }
          : prev,
      );
      return;
    }

    // Horizontal: midpoint of gap between sidebar edge and chat column.
    const left = scrollRect.left - containerRect.left + freeLeft / 2;

    // Vertical: 24px below the app bar — same offset as the top chat bubble.
    // Thread.Root fills the main area under the overlay top bar, so:
    // top = h-14 + 24px from the container top.
    const top = TOP_BAR_PX + CONTENT_TOP_GAP_PX;

    // Reading band used to score which day owns the viewport.
    const styleHost = scroller.closest(
      "[style*='--composer-dock-h']",
    ) as HTMLElement | null;
    const dockH =
      Number.parseFloat(
        styleHost?.style.getPropertyValue("--composer-dock-h") ?? "",
      ) || 120;
    const gapH =
      Number.parseFloat(
        styleHost?.style.getPropertyValue("--chat-composer-gap") ?? "",
      ) || 40;

    const viewTop = scrollRect.top + TOP_BAR_PX + CONTENT_TOP_GAP_PX;
    const viewBottom = scrollRect.bottom - dockH - gapH;

    const activeIndex = pickMajorityDayIndex(
      scroller,
      points,
      viewTop,
      Math.max(viewTop + 1, viewBottom),
    );

    setLayout({ left, top, visible: true, activeIndex });
  }, [contentMaxPx, containerRef, scrollRef]);

  const scheduleRecompute = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      recompute();
    });
  }, [recompute]);

  useLayoutEffect(() => {
    if (!scrollTickRef) return;
    scrollTickRef.current = scheduleRecompute;
    return () => {
      if (scrollTickRef.current === scheduleRecompute) {
        scrollTickRef.current = null;
      }
    };
  }, [scheduleRecompute, scrollTickRef]);

  useLayoutEffect(() => {
    let cancelled = false;
    let scroller: HTMLElement | null = null;
    let ro: ResizeObserver | null = null;
    let retryId = 0;

    const onScrollOrResize = () => {
      scheduleRecompute();
    };

    const cleanup = () => {
      if (scroller) {
        scroller.removeEventListener("scroll", onScrollOrResize);
      }
      ro?.disconnect();
      ro = null;
      window.removeEventListener("resize", onScrollOrResize);
      if (retryId) window.cancelAnimationFrame(retryId);
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    const tryAttach = (): boolean => {
      if (cancelled) return true;
      const node = scrollRef.current;
      if (!node) return false;

      scroller = node;
      scroller.addEventListener("scroll", onScrollOrResize, { passive: true });
      window.addEventListener("resize", onScrollOrResize);

      if (typeof ResizeObserver === "function") {
        ro = new ResizeObserver(onScrollOrResize);
        ro.observe(scroller);
        if (scroller.firstElementChild) {
          ro.observe(scroller.firstElementChild);
        }
      }

      scheduleRecompute();
      return true;
    };

    if (!tryAttach()) {
      const retry = () => {
        if (cancelled) return;
        if (!tryAttach()) {
          retryId = window.requestAnimationFrame(retry);
        }
      };
      retryId = window.requestAnimationFrame(retry);
    }

    return () => {
      cancelled = true;
      cleanup();
    };
  }, [scheduleRecompute, scrollRef, messages.length]);

  useLayoutEffect(() => {
    scheduleRecompute();
  }, [dayPoints, scheduleRecompute]);

  if (!layout.visible || dayPoints.length === 0) {
    return null;
  }

  const active = dayPoints[layout.activeIndex] ?? dayPoints[0]!;

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[12] hidden md:block"
      aria-hidden
    >
      <div
        className="absolute -translate-x-1/2 transition-opacity duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
        style={{ left: layout.left, top: layout.top }}
      >
        <time
          key={active.iso}
          dateTime={active.iso}
          title={active.title}
          className={`${DATE_CARD_CLASS} animate-fade-in`}
        >
          {active.label}
        </time>
      </div>
    </div>
  );
}

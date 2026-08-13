import { Loader2, Quote } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { ContextSnippetSourceRole } from "#/lib/chat/context-snippet-text";
import { normalizeContextText } from "#/lib/chat/context-snippet-text";

type SelectionState = {
  top: number;
  left: number;
  text: string;
  inView: boolean;
};

const TOOLBAR_GAP = 8;
const TOOLBAR_HEIGHT = 32;
/** Top app bar is h-14 — treat highlight under it as off-screen. */
const VIEW_TOP_INSET = 56;

function isRectInViewport(rect: DOMRect): boolean {
  return (
    rect.bottom > VIEW_TOP_INSET &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth
  );
}

function readBubbleSelection(
  container: HTMLElement | null,
  role: "user" | "assistant",
): SelectionState | null {
  if (!container) return null;
  const native = window.getSelection();
  if (!native || native.isCollapsed) return null;
  const { anchorNode, focusNode } = native;
  if (!anchorNode || !focusNode) return null;
  if (!container.contains(anchorNode) || !container.contains(focusNode)) {
    return null;
  }
  const text = normalizeContextText(native.toString(), role);
  if (text === null || native.rangeCount === 0) return null;
  const rect = native.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return {
    text,
    top: rect.top,
    left: rect.left + rect.width / 2,
    inView: isRectInViewport(rect),
  };
}

/**
 * Per-bubble "Add as context" popover. Shown after the selection gesture
 * ends (pointerup / keyup). Stays pinned to the highlight while it is in
 * view; hides when it scrolls off and returns when it scrolls back.
 *
 * Glass lives on the button itself. Do not fade/scale a wrapper: opacity
 * or transform on a parent flattens backdrop-filter.
 */
export function MessageSelectionToolbar({
  containerRef,
  role,
  disabled = false,
  onAddContext,
}: {
  containerRef: RefObject<HTMLElement | null>;
  role: "user" | "assistant";
  disabled?: boolean;
  onAddContext: (text: string, sourceRole: ContextSnippetSourceRole) => Promise<boolean>;
}) {
  const [selection, setSelection] = useState<SelectionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const pointerSelectingRef = useRef(false);
  const heldRef = useRef(false);

  const clearSelection = useCallback(() => {
    heldRef.current = false;
    setSelection(null);
  }, []);

  const commitSelection = useCallback(() => {
    if (disabled) {
      clearSelection();
      return;
    }
    const next = readBubbleSelection(containerRef.current, role);
    heldRef.current = next !== null;
    setSelection(next);
  }, [clearSelection, containerRef, disabled, role]);

  const trackSelection = useCallback(() => {
    if (!heldRef.current) return;
    const next = readBubbleSelection(containerRef.current, role);
    if (!next) {
      clearSelection();
      return;
    }
    setSelection(next);
  }, [clearSelection, containerRef, role]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelection();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") return;
      const isSelectionKey =
        event.shiftKey ||
        event.key === "Shift" ||
        event.key.startsWith("Arrow") ||
        event.key === "Home" ||
        event.key === "End" ||
        event.key === "a" ||
        event.key === "A";
      if (isSelectionKey) commitSelection();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (popoverRef.current?.contains(event.target as Node | null)) return;
      const inBubble = containerRef.current?.contains(event.target as Node | null);
      if (inBubble) {
        pointerSelectingRef.current = true;
        clearSelection();
      }
      // Clicks outside (scrollbar, empty chrome) leave the highlight alone;
      // selectionchange clears us only if the native selection actually dies.
    };
    const onPointerUp = () => {
      if (!pointerSelectingRef.current) return;
      pointerSelectingRef.current = false;
      requestAnimationFrame(() => commitSelection());
    };
    const onSelectionChange = () => {
      const native = window.getSelection();
      if (!native || native.isCollapsed) {
        clearSelection();
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [clearSelection, commitSelection]);

  const held = selection !== null;
  useEffect(() => {
    if (!held) return;
    let frame = 0;
    const onScrollOrResize = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        trackSelection();
      });
    };
    document.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [held, trackSelection]);

  const handleAdd = async () => {
    if (!selection || busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await onAddContext(selection.text, role);
    setBusy(false);
    if (ok) {
      window.getSelection()?.removeAllRanges();
      clearSelection();
    } else {
      setFailed(true);
      window.setTimeout(() => setFailed(false), 2000);
    }
  };

  if (!selection?.inView) return null;

  const panelTop = Math.max(selection.top - TOOLBAR_GAP - TOOLBAR_HEIGHT, 8);
  const panelLeft = Math.min(
    Math.max(selection.left - 70, 8),
    window.innerWidth - 148,
  );
  const portalRoot =
    document.getElementById("chat-surface") ?? document.body;

  return createPortal(
    <div
      ref={popoverRef}
      role="toolbar"
      aria-label="Selection actions"
      className="pointer-events-auto fixed z-10"
      style={{ top: panelTop, left: panelLeft }}
    >
      <button
        type="button"
        onClick={() => void handleAdd()}
        disabled={busy}
        className="glass glass-interactive inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium text-text transition-[color,background-color] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" strokeWidth={2.25} />
        ) : (
          <Quote className="size-3.5" strokeWidth={2.25} />
        )}
        {failed ? "Could not add" : busy ? "Adding…" : "Add as context"}
      </button>
    </div>,
    portalRoot,
  );
}

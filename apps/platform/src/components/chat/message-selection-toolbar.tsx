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
};

const TOOLBAR_GAP = 8;

/**
 * Per-bubble "Add as context" popover. Tracks text selection inside the
 * bubble's content container and floats a button above the selection end.
 * Hides on collapse, outside pointerdown, scroll (capture — the chat
 * viewport scroll doesn't bubble), and Escape.
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

  const computeSelection = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (disabled) {
      setSelection(null);
      return;
    }
    const native = window.getSelection();
    if (!native || native.isCollapsed) {
      setSelection(null);
      return;
    }
    const { anchorNode, focusNode } = native;
    if (!anchorNode || !focusNode) return;
    if (!container.contains(anchorNode) || !container.contains(focusNode)) {
      setSelection(null);
      return;
    }
    const text = normalizeContextText(native.toString(), role);
    if (text === null || native.rangeCount === 0) {
      setSelection(null);
      return;
    }
    const rect = native.getRangeAt(0).getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      setSelection(null);
      return;
    }
    setSelection({ top: rect.top, left: rect.left + rect.width / 2, text });
  }, [containerRef, disabled, role]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelection(null);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (popoverRef.current?.contains(event.target as Node | null)) return;
      if (containerRef.current?.contains(event.target as Node | null)) return;
      setSelection(null);
    };
    const onScroll = () => setSelection(null);
    document.addEventListener("selectionchange", computeSelection);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", computeSelection);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [computeSelection, containerRef]);

  const handleAdd = async () => {
    if (!selection || busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await onAddContext(selection.text, role);
    setBusy(false);
    if (ok) {
      window.getSelection()?.removeAllRanges();
      setSelection(null);
    } else {
      setFailed(true);
      window.setTimeout(() => setFailed(false), 2000);
    }
  };

  if (!selection) return null;

  const panelTop = Math.max(selection.top - TOOLBAR_GAP - 30, 8);
  const panelLeft = Math.min(
    Math.max(selection.left - 70, 8),
    window.innerWidth - 148,
  );

  return createPortal(
    <div
      ref={popoverRef}
      role="toolbar"
      aria-label="Selection actions"
      className="fixed z-[90] animate-scale-in"
      style={{ top: panelTop, left: panelLeft }}
    >
      <button
        type="button"
        onClick={() => void handleAdd()}
        disabled={busy}
        className="glass glass-interactive inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium text-text transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:text-text active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" strokeWidth={2.25} />
        ) : (
          <Quote className="size-3.5" strokeWidth={2.25} />
        )}
        {failed ? "Could not add" : busy ? "Adding…" : "Add as context"}
      </button>
    </div>,
    document.body,
  );
}

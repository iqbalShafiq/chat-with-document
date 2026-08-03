import type { ReactNode } from "react";

/**
 * Shared layout for soft-nav main panes (Projects, Documents, future menus).
 *
 * - Clears the absolute top bar (h-14 = 3.5rem) plus 24px breathing room
 * - Centers content at max-w-5xl so workspace pages stay visually consistent
 * - Re-mount triggers animate-fade-up (pass a stable key from the parent view)
 */
export function WorkspaceMainPane({
  children,
  className = "",
  /** Outer page scroll (Projects grid). Use false when the list scrolls inside. */
  scroll = true,
}: {
  children: ReactNode;
  className?: string;
  scroll?: boolean;
}) {
  return (
    <div
      className={[
        "flex min-h-0 flex-1 flex-col",
        scroll
          ? "chat-scroll overflow-y-auto overscroll-contain"
          : "overflow-hidden",
        // Top app bar h-14 (3.5rem) + 24px gap — matches chat room chrome
        "px-4 pb-10 pt-[calc(3.5rem+24px)] md:px-8",
        "animate-fade-up",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}

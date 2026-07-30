import { DocChatMark } from "#/components/layout/doc-chat-mark";
import { Menu, PanelLeftOpen, SquarePen } from "lucide-react";

export function ChatTopBar({
  title,
  sidebarOpen,
  isMobile,
  onToggleSidebar,
  onNewChat,
}: {
  title: string;
  sidebarOpen: boolean;
  isMobile: boolean;
  onToggleSidebar: () => void;
  onNewChat: () => void;
}) {
  const showLeftControl = isMobile || !sidebarOpen;
  const showNewChat = isMobile || !sidebarOpen;

  return (
    <header className="glass-top-bar absolute inset-x-0 top-0 z-20 flex h-14 items-center gap-2.5 px-3 md:px-4">
      {showLeftControl ? (
        isMobile ? (
          <button
            type="button"
            onClick={onToggleSidebar}
            aria-label="Open menu"
            title="Open menu"
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-white/[0.06] text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.1] hover:text-text active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring animate-fade-in"
          >
            <Menu className="size-4" strokeWidth={1.75} />
          </button>
        ) : (
          /* Desktop: logo ↔ expand, same crossfade as sidebar brand/collapse */
          <div className="group/expand relative size-8 shrink-0 animate-fade-in">
            <span
              className="absolute inset-0 transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/expand:scale-95 group-hover/expand:opacity-0 group-focus-within/expand:scale-95 group-focus-within/expand:opacity-0"
              aria-hidden
            >
              <DocChatMark />
            </span>
            <button
              type="button"
              onClick={onToggleSidebar}
              aria-label="Expand sidebar"
              title="Expand sidebar"
              className="absolute inset-0 flex cursor-pointer items-center justify-center rounded-xl bg-white/[0.06] text-text-muted opacity-0 scale-95 transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover/expand:scale-100 group-hover/expand:opacity-100 group-focus-within/expand:scale-100 group-focus-within/expand:opacity-100 hover:bg-white/[0.1] hover:text-text focus-visible:opacity-100 focus-visible:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring active:scale-[0.96]"
            >
              <PanelLeftOpen className="size-4" strokeWidth={1.75} />
            </button>
          </div>
        )
      ) : null}

      <h1
        className={`min-w-0 flex-1 truncate text-sm font-medium tracking-tight transition-colors duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          sidebarOpen && !isMobile ? "text-text-muted" : "text-text"
        }`}
      >
        {title}
      </h1>

      {showNewChat ? (
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
          className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.06] hover:text-text active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring animate-fade-in"
        >
          <SquarePen className="size-4" strokeWidth={1.75} />
        </button>
      ) : null}
    </header>
  );
}

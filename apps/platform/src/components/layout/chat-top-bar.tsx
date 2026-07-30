import { DocChatMark } from "#/components/layout/doc-chat-mark";
import { Menu, SquarePen } from "lucide-react";

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
    <header className="glass-surface relative z-10 flex h-14 shrink-0 items-center gap-2.5 border-b border-white/[0.08] px-3 md:px-4">
      {showLeftControl ? (
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label={isMobile ? "Open menu" : "Expand sidebar"}
          title={isMobile ? "Open menu" : "Expand sidebar"}
          className="inline-flex shrink-0 cursor-pointer items-center justify-center rounded-xl transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring animate-fade-in"
        >
          {isMobile ? (
            <span className="glass inline-flex size-8 items-center justify-center rounded-xl text-text-muted transition hover:bg-white/12 hover:text-text">
              <Menu className="size-4" strokeWidth={1.75} />
            </span>
          ) : (
            <DocChatMark className="transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:brightness-110" />
          )}
        </button>
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
          className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-xl text-text-muted transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.08] hover:text-text active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring animate-fade-in"
        >
          <SquarePen className="size-4" strokeWidth={1.75} />
        </button>
      ) : null}
    </header>
  );
}

import { ChevronUp, LogOut, Settings } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import { SettingsModal } from "#/components/settings/settings-modal";
import { authClient, userInitials, type SessionUser } from "#/lib/auth-client";
import { clearStoredSessionId } from "#/lib/session-storage";

export function AccountMenu({ user }: { user: SessionUser }) {
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState<{
    left: number;
    bottom: number;
    width: number;
  } | null>(null);
  const menuId = useId();
  const buttonId = useId();
  const navigate = useNavigate();
  const initials = userInitials(user);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPosition(null);
      return;
    }

    const updatePosition = () => {
      const root = rootRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      setMenuPosition({
        left: rect.left + 10,
        bottom: window.innerHeight - rect.top + 8,
        width: Math.max(0, rect.width - 20),
      });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const onLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await authClient.signOut();
      clearStoredSessionId();
      setOpen(false);
      await navigate({ to: "/login", search: { redirect: "/" } });
    } catch {
      setLoggingOut(false);
    }
  };

  const menu =
    open && menuPosition
      ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-labelledby={buttonId}
          className="glass-popover fixed z-[80] overflow-hidden rounded-2xl shadow-[0_12px_40px_-12px_rgb(0_0_0/0.65)] animate-scale-in"
          style={{
            left: menuPosition.left,
            bottom: menuPosition.bottom,
            width: menuPosition.width,
            transformOrigin: "bottom center",
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left text-sm text-text transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.06] active:scale-[0.99]"
          >
            <Settings className="size-4 shrink-0" strokeWidth={1.75} />
            <span>Settings</span>
          </button>
          <div className="mx-2 h-px bg-white/10" />
          <button
            type="button"
            role="menuitem"
            disabled={loggingOut}
            onClick={() => {
              void onLogout();
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2.5 text-left text-sm text-text transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.06] active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
          >
            <LogOut className="size-4 shrink-0" strokeWidth={1.75} />
            <span>{loggingOut ? "Signing out…" : "Log out"}</span>
          </button>
        </div>,
        document.body,
      )
      : null;

  return (
    <div ref={rootRef} className="relative shrink-0 px-2.5 py-3">
      {menu}

      <div className="flex min-h-12 items-center gap-3 px-1">
        <span className="glass-pane flex size-9 shrink-0 items-center justify-center rounded-xl text-xs font-semibold tracking-wide text-text">
          {initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text">
            {user.name}
          </span>
          <span className="block truncate text-[11px] text-text-muted">
            {user.email}
          </span>
        </span>
        <button
          ref={triggerRef}
          id={buttonId}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={open ? "Close account menu" : "Open account menu"}
          title={open ? "Close menu" : "Account menu"}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-text-faint transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/[0.08] hover:text-text-muted active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring"
        >
          <ChevronUp
            className={`size-4 transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
              open ? "rotate-0" : "rotate-180"
            }`}
            strokeWidth={1.75}
          />
        </button>
      </div>

      <SettingsModal
        open={settingsOpen}
        user={user}
        onClose={() => setSettingsOpen(false)}
        restoreFocusRef={triggerRef}
      />
    </div>
  );
}

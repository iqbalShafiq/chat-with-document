import { ChevronUp, LogOut, Settings } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

const HARDCODED_USER = {
  name: "Alya Rahman",
  plan: "Free",
  initials: "AR",
};

export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const buttonId = useId();

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
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

  return (
    <div ref={rootRef} className="relative shrink-0 px-2.5 py-3">
      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-labelledby={buttonId}
          className="absolute bottom-[calc(100%+0.5rem)] left-2.5 right-2.5 z-30 overflow-hidden rounded-2xl bg-canvas-elevated/95 shadow-[0_12px_40px_-12px_rgb(0_0_0/0.65)] ring-1 ring-white/[0.04] animate-scale-in"
          style={{ transformOrigin: "bottom center" }}
        >
          <button
            type="button"
            role="menuitem"
            disabled
            aria-disabled
            className="flex w-full cursor-not-allowed items-center gap-2.5 px-3 py-2.5 text-left text-sm text-text-muted opacity-70"
          >
            <Settings className="size-4 shrink-0" strokeWidth={1.75} />
            <span>Settings</span>
          </button>
          <div className="mx-2 h-px bg-white/10" />
          <button
            type="button"
            role="menuitem"
            disabled
            aria-disabled
            className="flex w-full cursor-not-allowed items-center gap-2.5 px-3 py-2.5 text-left text-sm text-text-muted opacity-70"
          >
            <LogOut className="size-4 shrink-0" strokeWidth={1.75} />
            <span>Log out</span>
          </button>
        </div>
      ) : null}

      {/* Account row: identity is static; only chevron toggles the menu */}
      <div className="flex min-h-12 items-center gap-3 px-1">
        <span className="glass-pane flex size-9 shrink-0 items-center justify-center rounded-xl text-xs font-semibold tracking-wide text-text">
          {HARDCODED_USER.initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-text">
            {HARDCODED_USER.name}
          </span>
          <span className="block text-[11px] text-text-muted">
            {HARDCODED_USER.plan}
          </span>
        </span>
        <button
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
    </div>
  );
}

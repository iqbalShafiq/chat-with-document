import { Outlet, useRouterState } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AuthChatDemo } from "#/components/auth/auth-chat-demo";
import { DocChatMark } from "#/components/layout/doc-chat-mark";

/**
 * Auth chrome — wide chat-demo rail + empty h-14 top bar + curved content frame.
 *
 * The rail is a live product preview (bubbles, tools, streaming, composer),
 * not a static marketing grid. Shared view-transition names morph into AppShell.
 */
export function AuthShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isRegister = pathname.startsWith("/register");

  return (
    <div className="relative flex h-[100dvh] max-h-[100dvh] overflow-hidden text-text">
      <div className="relative z-[1] flex min-h-0 min-w-0 flex-1">
        <div className="vt-sidebar hidden w-[min(36rem,52vw)] shrink-0 overflow-hidden lg:block">
          <div className="h-full w-full min-w-[30rem]">
            <AuthSidebar isRegister={isRegister} />
          </div>
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <header
            className="vt-topbar glass-top-bar absolute inset-x-0 top-0 z-20 flex h-14 items-center px-3 md:px-4"
            aria-hidden
          >
            <span className="lg:invisible lg:pointer-events-none">
              <DocChatMark />
            </span>
          </header>

          <main className="vt-main relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <div
              aria-hidden
              className="content-frame content-frame--with-sidebar hidden lg:block"
            />

            <div className="chat-scroll flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-5 pb-12 pt-[calc(3.5rem+32px)] md:px-10 lg:px-12">
              <div
                key={pathname}
                className="mx-auto flex w-full max-w-[22rem] flex-1 flex-col justify-center animate-fade-up sm:max-w-[24rem]"
              >
                <Outlet />
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function AuthSidebar({ isRegister }: { isRegister: boolean }) {
  return (
    <aside className="glass-sidebar flex h-full w-full min-h-0 flex-col">
      {/* Same h-14 brand row as chat sidebar */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 px-2.5">
        <DocChatMark />
        <span className="truncate text-sm font-semibold tracking-tight text-text">
          DocChat
        </span>
      </div>

      {/* Full remaining height = chat room preview (seed + multi-scene loop) */}
      <div
        key={isRegister ? "register" : "login"}
        className="relative flex min-h-0 flex-1 flex-col animate-fade-up"
      >
        <AuthChatDemo isRegister={isRegister} />
      </div>
    </aside>
  );
}

/**
 * Open form panel — no frosted card box.
 * Matches chat empty-state hierarchy: mark → title → quiet body → controls.
 */
export function AuthFormPanel({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="w-full">
      <div className="mb-8 flex items-center gap-2.5 lg:hidden">
        <div className="relative">
          <div
            className="absolute inset-0 rounded-xl bg-accent/20 blur-xl"
            aria-hidden
          />
          <span className="relative">
            <DocChatMark />
          </span>
        </div>
        <span className="text-sm font-semibold tracking-tight text-text">
          DocChat
        </span>
      </div>

      <header className="mb-8">
        <h2 className="text-balance text-[1.65rem] font-semibold leading-[1.15] tracking-tight text-text md:text-[1.85rem]">
          {title}
        </h2>
        <p className="mt-2.5 text-pretty text-sm leading-relaxed text-text-muted">
          {subtitle}
        </p>
      </header>

      {children}

      {footer ? (
        <p className="mt-8 text-center text-sm text-text-muted">{footer}</p>
      ) : null}
    </div>
  );
}

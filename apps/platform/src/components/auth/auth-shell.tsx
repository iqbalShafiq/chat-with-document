import type { ReactNode } from "react";
import { AuroraBackground } from "#/components/layout/aurora-background";
import { DocChatMark } from "#/components/layout/doc-chat-mark";

export function AuthShell({
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
    <div className="relative min-h-[100dvh] overflow-hidden bg-canvas text-text">
      <AuroraBackground />
      <div className="relative z-10 mx-auto grid min-h-[100dvh] w-full max-w-6xl grid-cols-1 items-center gap-10 px-5 py-12 md:grid-cols-[1.05fr_0.95fr] md:gap-14 md:px-8">
        <div className="animate-fade-up md:pr-6">
          <div className="mb-6 flex items-center gap-3">
            <DocChatMark />
            <span className="text-sm font-semibold tracking-tight text-text">
              DocChat
            </span>
          </div>
          <h1 className="max-w-md text-balance text-3xl font-semibold tracking-tight text-text md:text-[2.15rem] md:leading-[1.15]">
            {title}
          </h1>
          <p className="mt-3 max-w-md text-pretty text-sm leading-relaxed text-text-muted">
            {subtitle}
          </p>
        </div>

        <div
          className="glass-pane w-full max-w-md justify-self-center rounded-3xl p-6 shadow-[0_18px_48px_-18px_rgb(0_0_0/0.75)] ring-1 ring-white/[0.05] animate-scale-in md:justify-self-end md:p-7"
          style={{ transformOrigin: "center center" }}
        >
          {children}
          {footer ? (
            <div className="mt-5 border-t border-white/[0.06] pt-4 text-center text-sm text-text-muted">
              {footer}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

import { ScanSearch } from "lucide-react";

export function EmptyState() {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center gap-5 px-4 py-12 text-center animate-fade-up">
      <div className="relative">
        <div
          className="absolute inset-0 rounded-3xl bg-accent/20 blur-2xl"
          aria-hidden
        />
        <div className="glass relative flex size-16 items-center justify-center rounded-3xl text-accent">
          <ScanSearch className="size-7" strokeWidth={1.5} />
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-balance text-2xl font-semibold tracking-tight text-text md:text-[1.75rem]">
          Ask anything about your documents
        </h2>
        <p className="mx-auto max-w-md text-pretty text-sm leading-relaxed text-text-muted">
          Upload a PDF or image, then ask questions. Answers stay grounded in
          what you attached.
        </p>
      </div>
    </div>
  );
}

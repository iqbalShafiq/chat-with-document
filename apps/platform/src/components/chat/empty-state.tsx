type EmptyStateProps = {
  onSelectPrompt?: (prompt: string) => void;
};

/** Minimal editorial hero — only the watermark + headline, vertically centered. */
export function EmptyState(_props: EmptyStateProps) {
  return (
    <section className="anreal-empty mx-auto flex w-full max-w-[36rem] flex-1 flex-col justify-center px-6 py-10 animate-fade-up">
      <div className="anreal-empty-accent" aria-hidden />
      <div className="anreal-empty-main relative w-full">
        <div className="anreal-empty-watermark" aria-hidden>
          a
        </div>

        <header className="relative">
          <p className="anreal-empty-kicker mb-4 font-mono text-[10px] leading-none tracking-[0.18em] text-text-faint">
            ANREAL - NEW SESSION
          </p>
          <h2 className="text-balance text-[2.15rem] font-semibold leading-[0.92] tracking-[-0.06em] text-text md:text-[3rem]">
            What are you
            <br />
            <span className="font-[350] tracking-[-0.05em] text-text-muted">trying to understand?</span>
          </h2>
          <p className="mt-4 max-w-[28rem] text-pretty text-sm leading-[1.75] text-text-muted md:text-[14.5px]">
            Start with a question, or pick a direction. Every answer stays grounded in the PDFs and images you attach.
          </p>
        </header>
      </div>
    </section>
  );
}

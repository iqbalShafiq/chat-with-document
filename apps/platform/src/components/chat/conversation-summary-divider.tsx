export function ConversationSummaryDivider() {
  return (
    <div className="flex items-center gap-3 py-1" role="note">
      <span className="h-px flex-1 bg-white/[0.08]" />
      <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-text-faint">
        Earlier conversation summarized
      </span>
      <span className="h-px flex-1 bg-white/[0.08]" />
    </div>
  );
}

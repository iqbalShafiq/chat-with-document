import { Globe } from "lucide-react";

/**
 * Icon-only glass pill toggling per-session web search. No label by design
 * (matches the Model/Reasoning switcher density); the globe lights up with
 * the accent color when web search is enabled. Disabled when the server has
 * no TAVILY_API_KEY configured.
 */
export function WebSearchToggle({
  enabled,
  available = true,
  disabled = false,
  onToggle,
}: {
  enabled: boolean;
  /** Server has web tools configured (TAVILY_API_KEY). */
  available?: boolean;
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const locked = disabled || !available;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={available ? "Web search" : "Web search unavailable"}
      title={
        available
          ? enabled
            ? "Web search on — the agent searches the web freely"
            : "Web search off — the agent asks before searching"
          : "Web search is not configured on the server"
      }
      disabled={locked}
      onClick={() => onToggle(!enabled)}
      className={`glass inline-flex h-8 shrink-0 cursor-pointer items-center justify-center rounded-xl px-2 transition duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-white/12 active:scale-[0.98] disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring ${
        !available ? "opacity-40" : ""
      }`}
    >
      <Globe
        className={`size-4 transition-colors duration-200 ${
          enabled ? "text-accent" : "text-text-muted"
        }`}
        strokeWidth={1.75}
      />
    </button>
  );
}

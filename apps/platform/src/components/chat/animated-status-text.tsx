import { useEffect, useState } from "react";

/**
 * Status label with a cycling trailing ellipsis: "." → ".." → "..."
 * Used while the assistant run is pending / streaming but before visible tokens.
 */
export function AnimatedStatusText({
  label,
  intervalMs = 400,
}: {
  /** Base copy without trailing dots (e.g. "Thinking and writing"). */
  label: string;
  intervalMs?: number;
}) {
  const [dotCount, setDotCount] = useState(1);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setDotCount((current) => (current % 3) + 1);
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);

  return (
    <span aria-live="polite">
      {label}
      <span className="inline-block w-[1.25em] text-left" aria-hidden>
        {".".repeat(dotCount)}
      </span>
    </span>
  );
}

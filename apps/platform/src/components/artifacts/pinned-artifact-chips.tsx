import {
  CalendarClock,
  FileText,
  Globe,
  Images,
  Link2,
  ListChecks,
  MessagesSquare,
  Plug,
  X,
} from "lucide-react";
import {
  parsePinnedArtifactRefs,
  stripPinnedArtifactRefs,
  type ArtifactType,
} from "#/lib/api-artifacts";

export type PinnedArtifactPin = {
  type: ArtifactType;
  id: string;
  label: string;
};

export function pinIconForType(type: string) {
  return type === "site"
    ? Globe
    : type === "document"
      ? FileText
      : type === "image"
        ? Images
        : type === "task"
          ? ListChecks
          : type === "schedule"
            ? CalendarClock
            : type === "web_bundle"
              ? Link2
              : type === "session"
                ? MessagesSquare
                : Plug;
}

/**
 * Split raw `[@type label (id)]` references out of message text. The bubble
 * shows chips instead — raw tokens must never reach the reader.
 */
export function splitPinnedText(text: string): {
  cleanText: string;
  refs: PinnedArtifactPin[];
} {
  const parsed = parsePinnedArtifactRefs(text);
  if (parsed.length === 0) return { cleanText: text, refs: [] };
  return {
    cleanText: stripPinnedArtifactRefs(text),
    refs: parsed.map((ref) => ({
      type: ref.type,
      id: ref.id,
      label: ref.label || ref.id,
    })),
  };
}

/**
 * Pinned-artifact chips — same look in the composer and in chat bubbles.
 * Without `onRemove` the chips are read-only (bubble context).
 */
export function PinnedArtifactChips({
  pins,
  onRemove,
}: {
  pins: PinnedArtifactPin[];
  onRemove?: (type: string, id: string) => void;
}) {
  if (pins.length === 0) return null;
  return (
    <div
      className="flex min-w-0 flex-wrap gap-1.5"
      role="list"
      aria-label="Pinned artifacts"
    >
      {pins.map((pin) => {
        const Icon = pinIconForType(pin.type);
        return (
          <span
            key={`${pin.type}:${pin.id}`}
            role="listitem"
            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/[0.07] py-0 pl-2 pr-1 text-[11px] font-medium text-text animate-fade-in"
          >
            <Icon className="size-3 shrink-0 text-accent" strokeWidth={2} />
            <span className="min-w-0 flex-1 truncate">{pin.label}</span>
            {onRemove ? (
              <button
                type="button"
                aria-label={`Remove pinned ${pin.type} ${pin.label}`}
                onClick={() => onRemove(pin.type, pin.id)}
                className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-text-muted transition hover:bg-white/[0.08] hover:text-text"
              >
                <X className="size-3" />
              </button>
            ) : null}
          </span>
        );
      })}
    </div>
  );
}

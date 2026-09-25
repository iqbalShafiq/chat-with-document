import { MarkdownBody } from "#/components/math-markdown";
import {
  PinnedArtifactChips,
  splitPinnedText,
  type PinnedArtifactPin,
} from "#/components/artifacts/pinned-artifact-chips";

/**
 * Fence-aware split: tokens inside fenced code blocks stay plain text so
 * code samples are never rewritten into chips.
 */
function splitOutsideFences(text: string): { cleanText: string; refs: PinnedArtifactPin[] } {
  const segments = text.split(/(```[\s\S]*?```)/g);
  const refs: PinnedArtifactPin[] = [];
  const clean = segments
    .map((segment, index) => {
      if (index % 2 === 1) return segment; // pagar: jangan sentuh
      const { cleanText, refs: found } = splitPinnedText(segment);
      refs.push(...found);
      return cleanText;
    })
    .join("");
  return { cleanText: clean, refs };
}

/**
 * Render-only text part: pinned `[@type …]` tokens become read-only chips,
 * everything else renders as normal markdown. Raw message text elsewhere
 * (edit, resubmit, copy source) is untouched.
 */
export function PinnedTextPart({ role, text }: { role: string; text: string }) {
  if (role !== "user" && role !== "assistant") return <MarkdownBody content={text} />;
  const { cleanText, refs } = splitOutsideFences(text);
  if (refs.length === 0) return <MarkdownBody content={text} />;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <PinnedArtifactChips pins={refs} />
      {cleanText.trim() ? <MarkdownBody content={cleanText} /> : null}
    </div>
  );
}

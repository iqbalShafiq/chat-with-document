import { useMessagePart } from "@anvia/react-ui";
import { useMemo } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { CitationChip } from "#/components/chat/citation-chip";
import { useMessageCitations } from "#/components/chat/message-citation-context";
import {
  citationIdFromHref,
  isCitationHref,
  isPendingCitationHref,
  prepareCitationMarkdown,
  type MessageCitation,
} from "#/lib/chat/citations";
import "katex/dist/katex.min.css";

/**
 * Normalize common LLM math delimiters that remark-math does not understand.
 * Example: `[ \frac{a}{b} ]` → `$$\frac{a}{b}$$`
 */
export function normalizeMathMarkdown(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => {
      return `$$\n${body.trim()}\n$$`;
    })
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, body: string) => {
      return `$${body.trim()}$`;
    })
    .replace(/\[\s*(\\[\s\S]*?)\s*\]/g, (match, body: string) => {
      // Avoid turning markdown links/images into math.
      if (match.includes("](") || match.includes("][")) return match;
      if (!/\\[a-zA-Z{]/.test(body)) return match;
      return `$$\n${body.trim()}\n$$`;
    });
}

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

/** Keep citation hash targets; otherwise use react-markdown's safe transform. */
function citationAwareUrlTransform(url: string): string {
  if (isPendingCitationHref(url) || isCitationHref(url)) return url;
  return defaultUrlTransform(url);
}

function buildMarkdownComponents(
  byId: Map<number, MessageCitation>,
): Components {
  return {
    a: ({ href, children, node: _node, ...props }) => {
      // Always intercept citation markers — never render a real navigable link.
      if (isPendingCitationHref(href)) {
        return <CitationChip id={0} pending />;
      }
      if (isCitationHref(href)) {
        const id = citationIdFromHref(href);
        if (id !== null) {
          return <CitationChip id={id} citation={byId.get(id)} />;
        }
      }

      return (
        <a href={href} {...props}>
          {children}
        </a>
      );
    },
  };
}

export function MarkdownBody({ content }: { content: string }) {
  const messageCtx = useMessageCitations();
  const prepared = useMemo(() => prepareCitationMarkdown(content), [content]);

  // Prefer validated citations from message context when available.
  const byId = messageCtx?.byId ?? prepared.byId;

  const normalized = useMemo(
    () => normalizeMathMarkdown(prepared.markdown),
    [prepared.markdown],
  );
  const components = useMemo(
    () => buildMarkdownComponents(byId),
    [byId],
  );

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      urlTransform={citationAwareUrlTransform}
      components={components}
    >
      {normalized}
    </ReactMarkdown>
  );
}

export function MathMarkdown() {
  const { part } = useMessagePart();

  if (part.type !== "text") return null;

  return <MarkdownBody content={part.text} />;
}

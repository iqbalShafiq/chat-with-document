import { useMessagePart } from "@anvia/react-ui";
import { useMemo, type ComponentPropsWithoutRef } from "react";
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

/**
 * Prose + containment for chat markdown.
 * Wide children (pre/table/math/inline code) scroll inside their own element —
 * never expand the chat room horizontally.
 */
export const CHAT_MARKDOWN_CLASS = [
  "chat-markdown min-w-0 max-w-full break-words",
  // Headings
  "[&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:tracking-tight",
  "[&_h1:first-child]:mt-0",
  "[&_h2]:mb-2.5 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:tracking-tight",
  "[&_h2:first-child]:mt-0",
  "[&_h3]:mb-2 [&_h3]:mt-3.5 [&_h3]:text-[13px] [&_h3]:font-semibold",
  "[&_h3:first-child]:mt-0",
  // Paragraphs / hr
  "[&_p+p]:mt-3",
  "[&_hr]:my-4 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-white/[0.08]",
  // Emphasis
  "[&_strong]:font-semibold",
  "[&_em]:italic",
  // Links (citation chips strip underline via their own class)
  "[&_a]:text-accent [&_a]:underline [&_.citation-chip]:no-underline",
  // Lists
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5",
  "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5",
  "[&_li]:my-1",
  // Blockquote
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-accent/40 [&_blockquote]:pl-3 [&_blockquote]:text-text-muted [&_blockquote]:italic",
  // Tables (wrapper provides scroll; table fills wrapper)
  "[&_table]:my-0 [&_table]:w-max [&_table]:min-w-full [&_table]:border-collapse [&_table]:text-left [&_table]:text-[12px]",
  "[&_thead]:border-b [&_thead]:border-white/[0.1]",
  "[&_th]:px-2.5 [&_th]:py-1.5 [&_th]:font-semibold [&_th]:text-text",
  "[&_td]:border-t [&_td]:border-white/[0.05] [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:text-text-muted",
  // Images / math
  "[&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-lg",
  "[&_.katex-display]:my-3",
  "[&_.katex]:text-[1.05em]",
  // User bubble code tint (when nested under user role)
  "group-data-[role=user]:[&_code]:bg-white/[0.08]",
  "group-data-[role=user]:[&_a]:text-accent",
].join(" ");

function ChatCode({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"code">) {
  const text = typeof children === "string" ? children : String(children ?? "");
  const language = className?.match(/language-([\w+-]+)/)?.[1];
  const isBlock =
    Boolean(language) ||
    Boolean(className?.includes("language-")) ||
    text.includes("\n");

  if (!isBlock) {
    return (
      <code className="chat-md-inline-code" {...props}>
        {children}
      </code>
    );
  }

  return (
    <code
      className={`chat-md-code-block block whitespace-pre font-mono text-[0.85em] leading-relaxed text-text ${className ?? ""}`}
      {...props}
    >
      {children}
    </code>
  );
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
    // Per-element horizontal scroll — do not let wide tables expand the room.
    table: ({ children, node: _node, ...props }) => (
      <div className="chat-md-scroll my-3 max-w-full overflow-x-auto rounded-xl border border-white/[0.06]">
        <table {...props}>{children}</table>
      </div>
    ),
    pre: ({ children, node: _node, ...props }) => (
      <pre className="chat-md-pre chat-md-scroll" {...props}>
        {children}
      </pre>
    ),
    code: ChatCode,
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
    <div className={CHAT_MARKDOWN_CLASS}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        urlTransform={citationAwareUrlTransform}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}

export function MathMarkdown() {
  const { part } = useMessagePart();

  if (part.type !== "text") return null;

  return <MarkdownBody content={part.text} />;
}

import { useMessagePart } from "@anvia/react-ui";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
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

export function MarkdownBody({ content }: { content: string }) {
  const normalized = useMemo(
    () => normalizeMathMarkdown(content),
    [content],
  );

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
      {normalized}
    </ReactMarkdown>
  );
}

export function MathMarkdown() {
  const { part } = useMessagePart();

  if (part.type !== "text") return null;

  return <MarkdownBody content={part.text} />;
}

export function ReasoningMarkdown() {
  const { part } = useMessagePart();

  if (part.type !== "reasoning") return null;

  return <MarkdownBody content={part.text} />;
}

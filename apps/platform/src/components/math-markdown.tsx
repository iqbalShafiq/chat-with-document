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

export function MathMarkdown() {
  const { part } = useMessagePart();

  const content = useMemo(() => {
    if (part.type !== "text") return "";
    return normalizeMathMarkdown(part.text);
  }, [part]);

  if (part.type !== "text") return null;

  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>
      {content}
    </ReactMarkdown>
  );
}

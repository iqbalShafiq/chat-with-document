import { useMemo, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { normalizeMathMarkdown } from "#/components/math-markdown";
import "katex/dist/katex.min.css";

/**
 * Shared prose classes for document/OCR markdown — headings, lists, tables,
 * blockquotes, links. Code blocks use explicit components below so styling
 * is not dependent on Tailwind scanning long arbitrary-variant strings.
 */
export const DOCUMENT_MARKDOWN_CLASS = [
  "document-markdown break-words text-[13px] leading-relaxed text-text",
  // Headings
  "[&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:text-text",
  "[&_h1:first-child]:mt-0",
  "[&_h2]:mb-2.5 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-text",
  "[&_h2:first-child]:mt-0",
  "[&_h3]:mb-2 [&_h3]:mt-3.5 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:text-text",
  "[&_h3:first-child]:mt-0",
  "[&_h4]:mb-1.5 [&_h4]:mt-3 [&_h4]:text-[13px] [&_h4]:font-medium [&_h4]:text-text",
  "[&_h5]:mb-1.5 [&_h5]:mt-2.5 [&_h5]:text-xs [&_h5]:font-medium [&_h5]:text-text-muted",
  "[&_h6]:mb-1.5 [&_h6]:mt-2.5 [&_h6]:text-xs [&_h6]:font-medium [&_h6]:uppercase [&_h6]:tracking-wide [&_h6]:text-text-faint",
  // Paragraphs / horizontal rules
  "[&_p]:my-2 [&_p]:text-text-muted",
  "[&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
  "[&_hr]:my-4 [&_hr]:border-0 [&_hr]:border-t [&_hr]:border-white/[0.08]",
  // Emphasis
  "[&_strong]:font-semibold [&_strong]:text-text",
  "[&_em]:italic",
  "[&_del]:text-text-faint [&_del]:line-through",
  // Links
  "[&_a]:text-accent [&_a]:underline [&_a]:underline-offset-2 [&_a]:transition-colors hover:[&_a]:text-accent-hover",
  // Lists
  "[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:text-text-muted",
  "[&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:text-text-muted",
  "[&_li]:my-1 [&_li]:leading-relaxed",
  "[&_li>p]:my-1",
  "[&_ul_ul]:my-1 [&_ol_ol]:my-1 [&_ul_ol]:my-1 [&_ol_ul]:my-1",
  // Blockquote
  "[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-accent/40 [&_blockquote]:pl-3 [&_blockquote]:text-text-muted [&_blockquote]:italic",
  "[&_blockquote_p]:my-1.5",
  // Tables (GFM)
  "[&_table]:my-0 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left [&_table]:text-[12px]",
  "[&_thead]:border-b [&_thead]:border-white/[0.1]",
  "[&_th]:px-2.5 [&_th]:py-1.5 [&_th]:font-semibold [&_th]:text-text",
  "[&_td]:border-t [&_td]:border-white/[0.05] [&_td]:px-2.5 [&_td]:py-1.5 [&_td]:text-text-muted",
  "[&_tr:hover_td]:bg-white/[0.02]",
  // Images
  "[&_img]:my-3 [&_img]:max-w-full [&_img]:rounded-lg [&_img]:border [&_img]:border-white/[0.06]",
  // Math
  "[&_.katex-display]:my-3 [&_.katex-display]:overflow-x-auto",
  "[&_.katex]:text-[1.05em]",
].join(" ");

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex];

function CodeBlock({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<"code">) {
  // Fenced blocks: react-markdown puts language-* on the inner <code>.
  // Plain fences often still include a trailing newline in children.
  const text = typeof children === "string" ? children : String(children ?? "");
  const language = className?.match(/language-([\w+-]+)/)?.[1];
  const isBlock =
    Boolean(language) ||
    Boolean(className?.includes("language-")) ||
    text.includes("\n");

  if (!isBlock) {
    return (
      <code
        className="rounded bg-white/[0.08] px-1.5 py-0.5 font-mono text-[0.85em] text-text"
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <code
      className={`document-md-code-block block whitespace-pre font-mono text-[12px] leading-relaxed text-text ${className ?? ""}`}
      {...props}
    >
      {language ? (
        <span className="mb-2 block select-none font-sans text-[10px] font-medium uppercase tracking-wide text-text-faint">
          {language}
        </span>
      ) : null}
      {children}
    </code>
  );
}

const components: Components = {
  a: ({ href, children, node: _node, ...props }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
      {children}
    </a>
  ),
  table: ({ children, node: _node, ...props }) => (
    <div className="my-3 w-full overflow-x-auto rounded-xl border border-white/[0.06]">
      <table {...props}>{children}</table>
    </div>
  ),
  pre: ({ children, node: _node, ...props }) => (
    <pre
      className="document-md-pre my-3 overflow-x-auto rounded-xl border border-white/[0.08] bg-[#0a0a0a] p-3.5 text-[12px] leading-relaxed text-text shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
      {...props}
    >
      {children}
    </pre>
  ),
  code: CodeBlock,
};

/**
 * Markdown renderer for document OCR / page preview content.
 * GFM + math; no chat citation markers.
 */
export function DocumentMarkdown({
  content,
  className = "",
}: {
  content: string;
  className?: string;
}) {
  const normalized = useMemo(
    () => normalizeMathMarkdown(content),
    [content],
  );

  if (!content.trim()) return null;

  return (
    <div className={`${DOCUMENT_MARKDOWN_CLASS} ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}

/**
 * A plan document or a kept conversation, rendered (P14, D-P14-12).
 *
 * `react-markdown` with GitHub's tables and task lists, and **no raw HTML**:
 * `skipHtml` drops it, so a document can put no markup into the Studio (the
 * conversation file's own markers are HTML comments, and vanish with it).
 * Every element is styled from the theme's semantic utilities (A-49).
 */
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  h1: ({ children }) => <h2 className="mt-2 text-xl font-semibold tracking-tight">{children}</h2>,
  h2: ({ children }) => <h3 className="mt-4 text-lg font-semibold">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-3 text-base font-semibold">{children}</h4>,
  h4: ({ children }) => <h5 className="mt-2 text-sm font-semibold">{children}</h5>,
  p: ({ children }) => <p className="text-sm leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="ml-5 list-disc text-sm">{children}</ul>,
  ol: ({ children }) => <ol className="ml-5 list-decimal text-sm">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  a: ({ children, href }) => (
    <a href={href} className="underline" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
      {children}
    </blockquote>
  ),
  code: ({ children }) => (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border-b px-2 py-1 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-b px-2 py-1 align-top">{children}</td>,
  hr: () => <hr className="border-border" />,
};

export const Markdown = ({ text, label }: { readonly text: string; readonly label: string }) => (
  <section className="grid gap-2" aria-label={label} data-testid="markdown">
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={components}>
      {text}
    </ReactMarkdown>
  </section>
);

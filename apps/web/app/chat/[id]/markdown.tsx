'use client';

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const remarkPlugins = [remarkGfm];

/**
 * Hand-rolled prose styling for assistant bubbles — Tailwind preflight strips
 * element defaults, so each markdown element gets its classes back here.
 * `node` is destructured away so react-markdown's hast node never reaches the DOM.
 */
const components: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className="font-medium [overflow-wrap:anywhere] underline decoration-zinc-400 underline-offset-2 hover:decoration-current"
    >
      {children}
    </a>
  ),
  p: ({ node: _node, ...props }) => <p {...props} className="my-1.5 first:mt-0 last:mb-0" />,
  ul: ({ node: _node, ...props }) => (
    <ul {...props} className="my-1.5 list-disc pl-5 first:mt-0 last:mb-0" />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol {...props} className="my-1.5 list-decimal pl-5 first:mt-0 last:mb-0" />
  ),
  li: ({ node: _node, ...props }) => <li {...props} className="my-0.5" />,
  h1: ({ node: _node, ...props }) => (
    <h1 {...props} className="mt-3 mb-1.5 text-base font-semibold first:mt-0" />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 {...props} className="mt-3 mb-1 text-sm font-semibold first:mt-0" />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 {...props} className="mt-2 mb-1 text-sm font-semibold first:mt-0" />
  ),
  h4: ({ node: _node, ...props }) => (
    <h4 {...props} className="mt-2 mb-1 text-sm font-semibold first:mt-0" />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      {...props}
      className="my-1.5 border-l-2 border-zinc-400 pl-3 text-zinc-600 italic dark:border-zinc-600 dark:text-zinc-400"
    />
  ),
  hr: ({ node: _node, ...props }) => (
    <hr {...props} className="my-3 border-zinc-300 dark:border-zinc-700" />
  ),
  // react-markdown v10 has no `inline` flag: `code` gets inline styling, and
  // `pre` (block code wrapper) resets it on its child so blocks stay flat.
  code: ({ node: _node, ...props }) => (
    <code
      {...props}
      className="rounded bg-zinc-200 px-1 py-0.5 font-mono text-[0.85em] dark:bg-zinc-800"
    />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      {...props}
      className="my-2 overflow-x-auto rounded-md bg-zinc-900 p-3 font-mono text-xs text-zinc-100 first:mt-0 last:mb-0 dark:bg-zinc-950 [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0"
    />
  ),
  table: ({ node: _node, children, ...props }) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table {...props} className="w-full border-collapse text-xs">
        {children}
      </table>
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th
      {...props}
      className="border border-zinc-300 bg-zinc-200/60 px-2 py-1 text-left font-semibold dark:border-zinc-700 dark:bg-zinc-800/60"
    />
  ),
  td: ({ node: _node, ...props }) => (
    <td {...props} className="border border-zinc-300 px-2 py-1 dark:border-zinc-700" />
  ),
};

/** Assistant-message markdown (GFM: tables, strikethrough, task lists, autolinks). */
export function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="leading-relaxed">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

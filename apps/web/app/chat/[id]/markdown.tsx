'use client';

import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const remarkPlugins = [remarkGfm];

/**
 * Hand-rolled prose styling for assistant responses — Tailwind preflight strips
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
  p: ({ node: _node, ...props }) => <p {...props} className="my-2 first:mt-0 last:mb-0" />,
  ul: ({ node: _node, ...props }) => (
    <ul
      {...props}
      className="my-2.5 list-disc space-y-1 pl-5 marker:text-accent first:mt-0 last:mb-0"
    />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol
      {...props}
      className="my-2.5 list-decimal space-y-1 pl-5 marker:font-medium marker:text-muted first:mt-0 last:mb-0"
    />
  ),
  li: ({ node: _node, ...props }) => <li {...props} className="pl-0.5" />,
  h1: ({ node: _node, ...props }) => (
    <h1
      {...props}
      className="mt-6 mb-2 font-display text-xl font-semibold tracking-[-0.025em] first:mt-0"
    />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2
      {...props}
      className="mt-5 mb-2 border-b border-edge pb-1.5 text-[15px] font-semibold tracking-[-0.01em] first:mt-0"
    />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 {...props} className="mt-4 mb-1.5 text-[14px] font-semibold first:mt-0" />
  ),
  h4: ({ node: _node, ...props }) => (
    <h4 {...props} className="mt-2 mb-1 text-sm font-semibold first:mt-0" />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote {...props} className="my-3 border-l-2 border-accent/50 py-0.5 pl-3 text-muted" />
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
      className="my-3 overflow-x-auto rounded-xl bg-[#10131a] p-4 font-mono text-xs leading-5 text-zinc-100 shadow-inner first:mt-0 last:mb-0 dark:bg-black/40 [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0"
    />
  ),
  table: ({ node: _node, children, ...props }) => (
    <div className="my-3 overflow-x-auto rounded-xl border border-edge first:mt-0 last:mb-0">
      <table {...props} className="w-full border-collapse text-[13px]">
        {children}
      </table>
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th
      {...props}
      className="border-b border-edge bg-sunken/70 px-3 py-2 text-left font-semibold"
    />
  ),
  td: ({ node: _node, ...props }) => (
    <td
      {...props}
      className="border-b border-edge/70 px-3 py-2 last:[tr:last-child_&]:border-b-0"
    />
  ),
};

/** Assistant-message markdown (GFM: tables, strikethrough, task lists, autolinks). */
export function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="leading-6">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

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
      className="font-medium [overflow-wrap:anywhere] underline decoration-muted/70 underline-offset-2 hover:decoration-current"
    >
      {children}
    </a>
  ),
  p: ({ node: _node, className, ...props }) => (
    <p {...props} className={`my-2 first:mt-0 last:mb-0 ${className ?? ''}`} />
  ),
  ul: ({ node: _node, className, ...props }) => (
    <ul
      {...props}
      className={`my-2.5 list-disc space-y-1 pl-5 marker:text-accent first:mt-0 last:mb-0 [&.contains-task-list]:list-none [&.contains-task-list]:pl-0 ${className ?? ''}`}
    />
  ),
  ol: ({ node: _node, className, ...props }) => (
    <ol
      {...props}
      className={`my-2.5 list-decimal space-y-1 pl-5 marker:font-normal marker:text-muted first:mt-0 last:mb-0 ${className ?? ''}`}
    />
  ),
  li: ({ node: _node, className, ...props }) => (
    <li
      {...props}
      className={`pl-0.5 [&.task-list-item]:list-none [&.task-list-item]:pl-0 [&>p]:my-0 ${className ?? ''}`}
    />
  ),
  input: ({ node: _node, className, type, ...props }) => (
    <input
      {...props}
      type={type}
      className={`${
        type === 'checkbox' ? 'mr-2 size-4 align-[-0.15em] accent-accent disabled:opacity-100' : ''
      } ${className ?? ''}`}
    />
  ),
  strong: ({ node: _node, className, ...props }) => (
    <strong {...props} className={`font-semibold ${className ?? ''}`} />
  ),
  em: ({ node: _node, className, ...props }) => (
    <em {...props} className={`italic ${className ?? ''}`} />
  ),
  del: ({ node: _node, className, ...props }) => (
    <del {...props} className={`decoration-muted/70 ${className ?? ''}`} />
  ),
  h1: ({ node: _node, ...props }) => (
    <h1 {...props} className="mt-6 mb-2 text-lg leading-6 font-semibold first:mt-0" />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 {...props} className="mt-5 mb-1.5 text-base leading-6 font-semibold first:mt-0" />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 {...props} className="mt-4 mb-1.5 text-base leading-6 font-medium first:mt-0" />
  ),
  h4: ({ node: _node, ...props }) => (
    <h4 {...props} className="mt-4 mb-1 text-base leading-6 font-medium first:mt-0" />
  ),
  h5: ({ node: _node, ...props }) => (
    <h5 {...props} className="mt-4 mb-1 text-base leading-6 font-medium first:mt-0" />
  ),
  h6: ({ node: _node, ...props }) => (
    <h6 {...props} className="mt-4 mb-1 text-base leading-6 font-medium text-muted first:mt-0" />
  ),
  blockquote: ({ node: _node, ...props }) => (
    <blockquote {...props} className="my-3 border-l-2 border-accent/50 py-0.5 pl-3 text-muted" />
  ),
  hr: ({ node: _node, ...props }) => <hr {...props} className="my-3 border-edge" />,
  // react-markdown v10 has no `inline` flag: `code` gets inline styling, and
  // `pre` (block code wrapper) resets it on its child so blocks stay flat.
  code: ({ node: _node, className, ...props }) => (
    <code
      {...props}
      className={`break-words rounded bg-sunken px-1 py-0.5 font-mono text-[0.85em] [overflow-wrap:anywhere] ${className ?? ''}`}
    />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      {...props}
      className="my-3 max-w-full overscroll-x-contain overflow-x-auto rounded-xl bg-[#10131a] p-4 font-mono text-xs leading-5 text-zinc-100 first:mt-0 last:mb-0 dark:bg-black/40 [&_code]:break-normal [&_code]:rounded-none [&_code]:bg-transparent [&_code]:p-0 [&_code]:whitespace-pre [&_code]:[overflow-wrap:normal]"
    />
  ),
  table: ({ node: _node, children, ...props }) => (
    <div className="my-3 max-w-full overscroll-x-contain overflow-x-auto rounded-xl border border-edge first:mt-0 last:mb-0">
      <table {...props} className="w-full border-collapse text-sm">
        {children}
      </table>
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th
      {...props}
      className="border-b border-edge bg-sunken/70 px-3 py-2 text-left font-medium break-words [overflow-wrap:anywhere]"
    />
  ),
  td: ({ node: _node, ...props }) => (
    <td
      {...props}
      className="border-b border-edge/70 px-3 py-2 break-words [overflow-wrap:anywhere] last:[tr:last-child_&]:border-b-0"
    />
  ),
};

/** Assistant-message markdown (GFM: tables, strikethrough, task lists, autolinks). */
export function MessageMarkdown({ text }: { text: string }) {
  return (
    <div className="min-w-0 max-w-full break-words leading-relaxed [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

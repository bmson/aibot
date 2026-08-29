'use client';

import DOMPurify from 'dompurify';
import { useEffect, useId, useState } from 'react';

const MAX_SOURCE_CHARS = 20_000;

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const [svgUrl, setSvgUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let objectUrl = '';
    setSvgUrl('');
    setError('');
    if (source.length > MAX_SOURCE_CHARS) {
      setError('This diagram is too large to render safely.');
      return () => {
        cancelled = true;
      };
    }
    void import('mermaid')
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          htmlLabels: false,
          theme: 'base',
          flowchart: { htmlLabels: false, useMaxWidth: true },
          themeVariables: {
            primaryColor: '#e8f2ec',
            primaryTextColor: '#17251d',
            primaryBorderColor: '#2d8a5a',
            lineColor: '#47745c',
            secondaryColor: '#f3f7f4',
            tertiaryColor: '#ffffff',
          },
        });
        const id = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
        const rendered = await mermaid.render(id, source);
        if (cancelled) return;
        const safeSvg = DOMPurify.sanitize(rendered.svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
        });
        objectUrl = URL.createObjectURL(new Blob([safeSvg], { type: 'image/svg+xml' }));
        setSvgUrl(objectUrl);
        setError('');
      })
      .catch(() => {
        if (!cancelled) setError('This Mermaid diagram could not be rendered.');
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [reactId, source]);

  return (
    <figure className="my-3 overflow-hidden rounded-xl border border-edge bg-raised first:mt-0 last:mb-0">
      <figcaption className="border-b border-edge/60 bg-sunken/40 px-4 py-2 text-[11px] font-semibold tracking-[0.14em] text-accent uppercase">
        Diagram
      </figcaption>
      {svgUrl ? (
        <div className="overflow-x-auto p-4">
          {/* A sanitized in-memory SVG is not an optimizable network image. */}
          {/* biome-ignore lint/performance/noImgElement: blob URLs cannot use next/image. */}
          <img src={svgUrl} className="mx-auto h-auto max-w-full" alt="Rendered Mermaid diagram" />
        </div>
      ) : error ? (
        <p className="px-4 py-3 text-sm text-muted" role="status">
          {error}
        </p>
      ) : (
        <p className="px-4 py-3 text-sm text-muted" role="status">
          Rendering diagram…
        </p>
      )}
      <details className="border-t border-edge/60 px-4 py-2 text-xs text-muted">
        <summary className="cursor-pointer select-none font-medium text-strong">
          View diagram source
        </summary>
        <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-sunken p-3 font-mono text-[11px] leading-5">
          {source}
        </pre>
      </details>
    </figure>
  );
}

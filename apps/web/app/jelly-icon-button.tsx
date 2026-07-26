'use client';

import {
  type CSSProperties,
  createElement,
  type MouseEventHandler,
  type ReactNode,
  type Ref,
  useCallback,
} from 'react';

export type JellyButtonElement = HTMLElement;

const buttonStyle = {
  '--jelly-button-height': 'var(--nav-jelly-button-size)',
  '--jelly-button-min-width': 'var(--nav-jelly-button-size)',
  '--jelly-button-padding-inline': '0px',
  '--jelly-button-radius': 'var(--nav-jelly-button-radius)',
  '--jelly-fill': 'var(--surface-sunken)',
  '--jelly-label': 'var(--content-muted)',
  '--jelly-ring': 'var(--accent)',
} as CSSProperties;

/**
 * A small icon-only use of Jelly's square button. The library forwards the
 * accessible label and ARIA state to the native button in its shadow root.
 */
export function JellyIconButton({
  buttonRef,
  children,
  className = '',
  controls,
  expanded,
  label,
  onClick,
  title,
}: {
  buttonRef?: Ref<JellyButtonElement>;
  children: ReactNode;
  className?: string;
  controls?: string;
  expanded?: boolean;
  label: string;
  onClick: MouseEventHandler<HTMLElement>;
  title?: string;
}) {
  // React assigns a custom-element prop when a same-named property exists.
  // Jelly also has an internal shape() method, so passing shape="square"
  // through React would overwrite that method on elements created after the
  // library has registered. Set the public HTML attribute directly instead.
  const connectButton = useCallback(
    (element: JellyButtonElement | null) => {
      element?.setAttribute('shape', 'square');
      if (typeof buttonRef === 'function') {
        buttonRef(element);
      } else if (buttonRef) {
        buttonRef.current = element;
      }
    },
    [buttonRef],
  );

  return createElement(
    'jelly-button',
    {
      'aria-controls': controls,
      'aria-expanded': expanded === undefined ? undefined : String(expanded),
      // Keep the light-DOM host labelled as well as Jelly's shadow button.
      // Focus management and accessibility checks see the custom-element host
      // as document.activeElement when its internal control owns focus.
      'aria-label': label,
      className: `nav-jelly-button ${className}`.trim(),
      label,
      onClick,
      ref: connectButton,
      size: 'small',
      style: buttonStyle,
      title,
      type: 'button',
      variant: 'platinum',
    },
    children,
  );
}

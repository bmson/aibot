'use client';

import {
  type CSSProperties,
  createElement,
  type MouseEventHandler,
  type ReactNode,
  type Ref,
  useCallback,
  useRef,
} from 'react';
import { useJellyReady } from './jelly-ready';

export type JellyButtonElement = HTMLElement;
export type JellyButtonTone = 'outline' | 'primary' | 'danger' | 'dangerOutline' | 'success';

const buttonStyle = {
  '--jelly-button-height': 'var(--nav-jelly-button-size)',
  '--jelly-button-min-width': 'var(--nav-jelly-button-size)',
  '--jelly-button-padding-inline': '0px',
  '--jelly-button-radius': 'var(--nav-jelly-button-radius)',
  '--jelly-fill': 'var(--surface-sunken)',
  '--jelly-label': 'var(--content-muted)',
  '--jelly-ring': 'var(--accent)',
} as CSSProperties;

const toneVariant: Record<JellyButtonTone, 'platinum' | 'azure' | 'rose' | 'mint'> = {
  outline: 'platinum',
  primary: 'azure',
  danger: 'rose',
  dangerOutline: 'rose',
  success: 'mint',
};

/**
 * Text or icon+text Jelly button for app actions. Jelly buttons are
 * form-associated custom elements, so type="submit" keeps native form and
 * server-action behavior while gaining the soft-body press response.
 */
export function JellyButton({
  busy,
  buttonRef,
  children,
  className = '',
  controls,
  disabled,
  expanded,
  iconOnly = false,
  label,
  onClick,
  pressed,
  size = 'md',
  style,
  testId,
  title,
  tone = 'outline',
  type = 'button',
}: {
  busy?: boolean;
  buttonRef?: Ref<JellyButtonElement>;
  children: ReactNode;
  className?: string;
  controls?: string;
  disabled?: boolean;
  expanded?: boolean;
  iconOnly?: boolean;
  label?: string;
  onClick?: MouseEventHandler<HTMLElement>;
  pressed?: boolean;
  size?: 'sm' | 'md';
  style?: CSSProperties;
  testId?: string;
  title?: string;
  tone?: JellyButtonTone;
  type?: 'button' | 'submit' | 'reset';
}) {
  const ready = useJellyReady('jelly-button');
  const localButtonRef = useRef<JellyButtonElement | null>(null);
  const restoreFocusRef = useRef(false);
  const connectButton = useCallback(
    (element: JellyButtonElement | null) => {
      const previous = localButtonRef.current;
      if (!element && previous) {
        restoreFocusRef.current =
          document.activeElement === previous || previous.contains(document.activeElement);
      }
      localButtonRef.current = element;
      if (iconOnly) element?.setAttribute('shape', 'square');
      if (element && restoreFocusRef.current) {
        restoreFocusRef.current = false;
        queueMicrotask(() => element.focus());
      }
      if (typeof buttonRef === 'function') {
        buttonRef(element);
      } else if (buttonRef) {
        buttonRef.current = element;
      }
    },
    [buttonRef, iconOnly],
  );
  const resolvedClassName =
    `app-jelly-button mobile-touch-target ${iconOnly ? 'app-jelly-button-icon' : ''} ${className}`.trim();

  if (!ready) {
    return (
      <button
        ref={connectButton}
        type={type}
        aria-busy={busy ? 'true' : undefined}
        aria-controls={controls}
        aria-expanded={expanded}
        aria-label={label}
        aria-pressed={pressed}
        className={`${resolvedClassName} app-jelly-fallback`}
        data-size={size}
        data-testid={testId}
        data-tone={tone}
        disabled={disabled}
        onClick={onClick as MouseEventHandler<HTMLButtonElement>}
        style={style}
        title={title}
      >
        {children}
      </button>
    );
  }

  return createElement(
    'jelly-button',
    {
      'aria-busy': busy ? 'true' : undefined,
      'aria-controls': controls,
      'aria-expanded': expanded === undefined ? undefined : String(expanded),
      'aria-label': label,
      'aria-pressed': pressed === undefined ? undefined : String(pressed),
      className: resolvedClassName,
      'data-size': size,
      'data-testid': testId,
      'data-tone': tone,
      disabled,
      label,
      onClick,
      ref: connectButton,
      size: size === 'sm' ? 'small' : 'medium',
      style,
      title,
      type,
      variant: toneVariant[tone],
    },
    children,
  );
}

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
  return (
    <JellyButton
      buttonRef={buttonRef}
      type="button"
      iconOnly
      size="sm"
      label={label}
      controls={controls}
      expanded={expanded}
      onClick={onClick}
      className={`nav-jelly-button ${className}`.trim()}
      style={buttonStyle}
      title={title}
    >
      {children}
    </JellyButton>
  );
}

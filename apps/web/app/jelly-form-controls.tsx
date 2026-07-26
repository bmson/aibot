'use client';

import {
  createElement,
  type KeyboardEventHandler,
  type MutableRefObject,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useJellyReady } from './jelly-ready';

export interface JellyInputElement extends HTMLElement {
  value: string;
  focus(options?: FocusOptions): void;
}

export interface JellyTextareaElement extends HTMLElement {
  value: string;
  focus(options?: FocusOptions): void;
}

type SharedProps<T extends HTMLElement> = {
  activeDescendant?: string;
  ariaLabel: string;
  autoComplete?: string;
  className?: string;
  controls?: string;
  defaultValue?: string;
  disabled?: boolean;
  id?: string;
  inputRef?: Ref<T>;
  label?: string;
  name?: string;
  onKeyDown?: KeyboardEventHandler<T>;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  readonly?: boolean;
  size?: 'sm' | 'md';
  testId?: string;
  value?: string;
};

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

function syncAria(
  control: HTMLElement | null,
  {
    activeDescendant,
    ariaLabel,
    controls,
  }: Pick<SharedProps<HTMLElement>, 'activeDescendant' | 'ariaLabel' | 'controls'>,
) {
  if (!control) return;
  for (const [name, value] of [
    ['aria-activedescendant', activeDescendant],
    ['aria-controls', controls],
    ['aria-label', ariaLabel],
  ] as const) {
    if (value) control.setAttribute(name, value);
    else control.removeAttribute(name);
  }
}

function useUncontrolledFormReset<T extends JellyInputElement | JellyTextareaElement>({
  defaultValue,
  elementRef,
  onValueChange,
  setFormValue,
  value,
}: {
  defaultValue?: string;
  elementRef: MutableRefObject<T | null>;
  onValueChange?: (value: string) => void;
  setFormValue: (value: string) => void;
  value?: string;
}) {
  useEffect(() => {
    const form = elementRef.current?.closest('form');
    if (!form || value !== undefined) return;
    const reset = () => {
      const resetValue = defaultValue ?? '';
      setFormValue(resetValue);
      onValueChange?.(resetValue);
      // Jelly does not currently implement formResetCallback. Mirror the
      // native default after the reset event while the adapter owns the field.
      queueMicrotask(() => {
        if (elementRef.current) elementRef.current.value = resetValue;
      });
    };
    form.addEventListener('reset', reset);
    return () => form.removeEventListener('reset', reset);
  }, [defaultValue, elementRef, onValueChange, setFormValue, value]);
}

/**
 * Optional/app-controlled fields use Jelly after its module registers. Native
 * validation fields stay native elsewhere in the app. The fallback remains a
 * fully functional input and preserves text typed before Jelly becomes ready.
 */
export function JellyInput({
  activeDescendant,
  ariaLabel,
  autoComplete,
  className = '',
  controls,
  defaultValue,
  disabled,
  id,
  inputRef,
  label,
  name,
  onKeyDown,
  onValueChange,
  placeholder,
  readonly,
  size = 'sm',
  testId,
  type = 'text',
  value,
}: SharedProps<JellyInputElement> & { type?: 'email' | 'search' | 'text' | 'url' }) {
  const ready = useJellyReady('jelly-input');
  const localRef = useRef<JellyInputElement | null>(null);
  const restoreFocusRef = useRef(false);
  const handoffValueRef = useRef<string | null>(null);
  const [formValue, setFormValue] = useState(value ?? defaultValue ?? '');
  const resolvedValue = value ?? formValue;
  const resolvedValueRef = useRef(resolvedValue);
  resolvedValueRef.current = resolvedValue;
  const updateValue = useCallback(
    (next: string) => {
      setFormValue(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );
  const connect = useCallback(
    (element: JellyInputElement | null) => {
      const previous = localRef.current;
      if (!element && previous) {
        handoffValueRef.current = previous.value;
        restoreFocusRef.current =
          document.activeElement === previous || previous.contains(document.activeElement);
      }
      localRef.current = element;
      if (label) element?.setAttribute('label', label);
      if (name) element?.setAttribute('name', name);
      const pendingHandoff = handoffValueRef.current;
      const handoffValue = pendingHandoff ?? resolvedValueRef.current;
      if (element && element.value !== handoffValue) {
        element.value = handoffValue;
      }
      // A user can type between `whenDefined()` resolving and React replacing
      // the native fallback. The DOM value survives that swap, but the native
      // input event may lose its React target as the node detaches. Reconcile
      // the captured value with both adapter and parent state before the
      // upgraded control can render dependent UI (for example, Send enabled).
      if (element && pendingHandoff !== null && pendingHandoff !== resolvedValueRef.current) {
        resolvedValueRef.current = pendingHandoff;
        updateValue(pendingHandoff);
      }
      if (element) handoffValueRef.current = null;
      if (element && restoreFocusRef.current) {
        restoreFocusRef.current = false;
        queueMicrotask(() => element.focus());
      }
      assignRef(inputRef, element);
    },
    [inputRef, label, name, updateValue],
  );
  useUncontrolledFormReset({
    defaultValue,
    elementRef: localRef,
    onValueChange,
    setFormValue,
    value,
  });

  useEffect(() => {
    if (!ready) return;
    const host = localRef.current;
    const inner = host?.shadowRoot?.querySelector('input') ?? host;
    syncAria(inner, { activeDescendant, ariaLabel, controls });
    const handleInput = (event: Event) => {
      // Jelly emits an untrusted input event when React assigns its `value`
      // property. Feeding that event back into a controlled field can make
      // the old/new values oscillate while a form resets or submits.
      if (!event.isTrusted) return;
      const next = (event.currentTarget as HTMLInputElement).value ?? host?.value ?? '';
      if (next === resolvedValueRef.current) return;
      resolvedValueRef.current = next;
      updateValue(next);
    };
    inner?.addEventListener('input', handleInput);
    return () => inner?.removeEventListener('input', handleInput);
  }, [activeDescendant, ariaLabel, controls, ready, updateValue]);

  useEffect(() => {
    if (value !== undefined) {
      setFormValue(value);
      if (localRef.current && localRef.current.value !== value) localRef.current.value = value;
    }
  }, [value]);

  const resolvedClassName = `app-jelly-input ${className}`.trim();
  if (!ready) {
    return (
      <input
        ref={(element) => connect(element as JellyInputElement | null)}
        id={id}
        name={name}
        type={type}
        value={resolvedValue}
        aria-activedescendant={activeDescendant}
        aria-controls={controls}
        aria-label={ariaLabel}
        autoComplete={autoComplete}
        className={`${resolvedClassName} app-jelly-fallback`}
        data-testid={testId}
        disabled={disabled}
        onChange={(event) => updateValue(event.currentTarget.value)}
        onKeyDown={onKeyDown as KeyboardEventHandler<HTMLInputElement>}
        placeholder={placeholder}
        readOnly={readonly}
      />
    );
  }

  return createElement('jelly-input', {
    'aria-activedescendant': activeDescendant,
    'aria-controls': controls,
    'aria-label': ariaLabel,
    autocomplete: autoComplete,
    className: resolvedClassName,
    'data-testid': testId,
    disabled,
    id,
    label: label ?? ariaLabel,
    onKeyDown,
    placeholder,
    readonly,
    ref: connect,
    size: size === 'sm' ? 'small' : 'medium',
    type,
    value: resolvedValue,
  });
}

/** Auto-growing optional textarea with the same native-until-ready contract. */
export function JellyTextarea({
  activeDescendant,
  ariaLabel,
  autoComplete,
  className = '',
  controls,
  defaultValue,
  disabled,
  id,
  inputRef,
  label,
  name,
  onKeyDown,
  onValueChange,
  placeholder,
  readonly,
  rows = 3,
  size = 'sm',
  testId,
  value,
}: SharedProps<JellyTextareaElement> & { rows?: number }) {
  const ready = useJellyReady('jelly-textarea');
  const localRef = useRef<JellyTextareaElement | null>(null);
  const restoreFocusRef = useRef(false);
  const handoffValueRef = useRef<string | null>(null);
  const [formValue, setFormValue] = useState(value ?? defaultValue ?? '');
  const resolvedValue = value ?? formValue;
  const resolvedValueRef = useRef(resolvedValue);
  resolvedValueRef.current = resolvedValue;
  const updateValue = useCallback(
    (next: string) => {
      setFormValue(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );
  const connect = useCallback(
    (element: JellyTextareaElement | null) => {
      const previous = localRef.current;
      if (!element && previous) {
        handoffValueRef.current = previous.value;
        restoreFocusRef.current =
          document.activeElement === previous || previous.contains(document.activeElement);
      }
      localRef.current = element;
      if (label) element?.setAttribute('label', label);
      if (name) element?.setAttribute('name', name);
      const pendingHandoff = handoffValueRef.current;
      const handoffValue = pendingHandoff ?? resolvedValueRef.current;
      if (element && element.value !== handoffValue) {
        element.value = handoffValue;
      }
      if (element && pendingHandoff !== null && pendingHandoff !== resolvedValueRef.current) {
        resolvedValueRef.current = pendingHandoff;
        updateValue(pendingHandoff);
      }
      if (element) handoffValueRef.current = null;
      if (element && restoreFocusRef.current) {
        restoreFocusRef.current = false;
        queueMicrotask(() => element.focus());
      }
      assignRef(inputRef, element);
    },
    [inputRef, label, name, updateValue],
  );
  useUncontrolledFormReset({
    defaultValue,
    elementRef: localRef,
    onValueChange,
    setFormValue,
    value,
  });

  useEffect(() => {
    if (!ready) return;
    const host = localRef.current;
    const inner = host?.shadowRoot?.querySelector('textarea') ?? host;
    syncAria(inner, { activeDescendant, ariaLabel, controls });
    const handleInput = (event: Event) => {
      if (!event.isTrusted) return;
      const next = (event.currentTarget as HTMLTextAreaElement).value ?? host?.value ?? '';
      if (next === resolvedValueRef.current) return;
      resolvedValueRef.current = next;
      updateValue(next);
    };
    inner?.addEventListener('input', handleInput);
    return () => inner?.removeEventListener('input', handleInput);
  }, [activeDescendant, ariaLabel, controls, ready, updateValue]);

  useEffect(() => {
    if (value !== undefined) {
      setFormValue(value);
      if (localRef.current && localRef.current.value !== value) localRef.current.value = value;
    }
  }, [value]);

  const resolvedClassName = `app-jelly-textarea ${className}`.trim();
  if (!ready) {
    return (
      <textarea
        ref={(element) => connect(element as JellyTextareaElement | null)}
        id={id}
        name={name}
        value={resolvedValue}
        aria-activedescendant={activeDescendant}
        aria-controls={controls}
        aria-label={ariaLabel}
        autoComplete={autoComplete}
        className={`${resolvedClassName} app-jelly-fallback`}
        data-testid={testId}
        disabled={disabled}
        onChange={(event) => updateValue(event.currentTarget.value)}
        onKeyDown={onKeyDown as KeyboardEventHandler<HTMLTextAreaElement>}
        placeholder={placeholder}
        readOnly={readonly}
        rows={rows}
      />
    );
  }

  return createElement('jelly-textarea', {
    'aria-activedescendant': activeDescendant,
    'aria-controls': controls,
    'aria-label': ariaLabel,
    autocomplete: autoComplete,
    className: resolvedClassName,
    'data-testid': testId,
    disabled,
    id,
    label: label ?? ariaLabel,
    onKeyDown,
    placeholder,
    readonly,
    ref: connect,
    rows,
    size: size === 'sm' ? 'small' : 'medium',
    value: resolvedValue,
  });
}

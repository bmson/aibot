'use client';

import { useCallback, useSyncExternalStore } from 'react';

const getServerSnapshot = () => false;

/**
 * Custom elements load after React hydrates. Adapters keep a native control on
 * screen until the pinned Jelly bundle has registered the matching element,
 * avoiding inert unknown-element controls on slow or blocked script loads.
 */
export function useJellyReady(tagName: string) {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (customElements.get(tagName)) return () => {};
      let active = true;
      void customElements.whenDefined(tagName).then(() => {
        if (active) notify();
      });
      return () => {
        active = false;
      };
    },
    [tagName],
  );
  const getSnapshot = useCallback(() => Boolean(customElements.get(tagName)), [tagName]);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

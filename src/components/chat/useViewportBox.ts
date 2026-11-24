'use client';

import { useEffect, type RefObject } from 'react';

/** Visible-viewport shrink beyond this means the on-screen keyboard is up. */
const KEYBOARD_MIN_PX = 120;

/**
 * Keeps a fixed full-screen box sized to the visible viewport, so the composer rides right above
 * the iOS keyboard (iOS does not resize the layout viewport for it). Also marks the box with
 * data-keyboard="open|closed" for styling.
 */
export function useViewportBox(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    const vv = window.visualViewport;
    if (!el || !vv) return;
    const apply = () => {
      el.style.height = `${vv.height}px`;
      el.style.transform = `translate3d(0, ${vv.offsetTop}px, 0)`;
      el.dataset.keyboard = window.innerHeight - vv.height > KEYBOARD_MIN_PX ? 'open' : 'closed';
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, [ref]);
}

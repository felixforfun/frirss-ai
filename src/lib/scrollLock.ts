// ── Shared overlay scroll lock ─────────────────────────────────────────────
//
// With the old fixed-height shell (`overflow: hidden` on `.app-shell`), the
// document could never scroll, so overlays never needed a lock. In document
// scroll mode (mobile, Safari browser tab) they do: a bottom sheet, drawer or
// modal would otherwise chain its touch scrolling to the document behind it
// and let the pinned bars wander away mid interaction.
//
// `body { overflow: hidden }` is NOT reliable on iOS: WebKit ignores it when
// a gesture is already scrolling (§4.E of the brief). The reliable freeze is
// `position: fixed` on the body at the exact scroll offset, restamped on
// close — no background scroll, and no jump on close (the offset is restored
// synchronously before the next paint).
//
// In container mode (PWA, desktop, tablet) the document never scrolls, so
// freezing is a no-op visually — but it is also what makes the utility safe
// to install on EVERY modal portal, not just the mobile ones.
//
// Stacking: nesting two locks (e.g. drawer → confirm dialog) must not stack
// the `-y` offsets. A single reference counter keeps the body frozen while
// the first lock is alive; every consumer installs/uninstalls symmetrically
// through React cleanup, so counting stays exact.

import { useEffect } from 'react';

let depth = 0;
let savedY = 0;
let savedStyles: string | null = null;

export function lockBodyScroll(): () => void {
  if (typeof document === 'undefined') return () => {};
  if (depth === 0) {
    savedY = window.scrollY || window.pageYOffset || 0;
    const body = document.body;
    const prev = body.getAttribute('style');
    savedStyles = prev;
    body.style.position = 'fixed';
    body.style.top = `-${savedY}px`;
    body.style.left = '0';
    body.style.right = '0';
    body.style.width = '100%';
  }
  depth += 1;
  return () => {
    depth = Math.max(0, depth - 1);
    if (depth > 0) return;
    const body = document.body;
    if (savedStyles === null) body.removeAttribute('style');
    else body.setAttribute('style', savedStyles);
    savedStyles = null;
    // Synchronous restore before the browser paints the unfrozen body.
    // Skip the exact no-op so scroll-capability-less environments (jsdom)
    // never even attempt the call.
    if (window.scrollY !== savedY) window.scrollTo(0, savedY);
  };
}

/**
 * React convenience: install the lock while `active` is true, dispose when it
 * flips or on unmount — always symmetric, safe with StrictMode double-invoke
 * because the disposer is per-instance.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    return lockBodyScroll();
  }, [active]);
}

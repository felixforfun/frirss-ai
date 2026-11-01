// ── Scroll ownership: gated document-scrolling mode (mobile browser) ─────
//
// iOS Safari collapses and re-expands its toolbars ONLY when the DOCUMENT is
// the scroller. FriRSS's mobile shell used to scroll inner containers inside
// a `100dvh` locked shell, so the document never scrolled and the toolbars
// never moved (see PR brief §3).
//
// The container architecture stays byte-for-byte identical for:
//   • the installed PWA (standalone) — guaranteed pixel identity (§0.1),
//   • desktop and tablet breakpoints (multi-pane layouts cannot scroll one
//     document),
//   • the legacy path for every consumer that keeps inner scrollers.
//
// Gate (§4.H, option b): document scrolling applies only when the mobile
// breakpoint is active AND the app is NOT running standalone. A `?scroll=doc`
// / `?scroll=container` URL override (cached in localStorage) lets the owner
// A/B both architectures on a single device without redeploying; it is
// developer tooling only and never changes the default.

const OVERRIDE_PARAM = 'scroll';
const OVERRIDE_KEY = 'frirss_scrollModeOverride';

/** `navigator.standalone` (iOS Safari only) or the standalone display mode. */
function isStandalone(): boolean {
  if (typeof navigator !== 'undefined' && 'standalone' in navigator) {
    if ((navigator as { standalone?: unknown }).standalone === true) return true;
  }
  if (typeof matchMedia === 'function') {
    try {
      return matchMedia('(display-mode: standalone)').matches;
    } catch {
      /* no matchMedia (very old WebKit, tests) — treat as browser */
    }
  }
  return false;
}

/** Explicit A/B override from `?scroll=doc|container` (dev only). */
function readOverride(): 'doc' | 'container' | null {
  try {
    const param = typeof URLSearchParams !== 'undefined'
      ? new URLSearchParams(window.location.search).get(OVERRIDE_PARAM)
      : null;
    if (param === 'doc' || param === 'container') {
      localStorage.setItem(OVERRIDE_KEY, param);
      return param;
    }
    const saved = localStorage.getItem(OVERRIDE_KEY);
    return saved === 'doc' || saved === 'container' ? saved : null;
  } catch {
    return null;
  }
}

/**
 * True when this rendering context should hand scrolling to the document.
 * JavaScript reads it to bind scroll listeners and pick layout classes; the
 * same decision mirrors the `html[data-scroll="doc"]` attribute App sets for
 * CSS (kept in sync by `applyDocScrollState`).
 */
export function docScrollEnabled(): boolean {
  try {
    if (typeof window === 'undefined') return false;
    const override = readOverride();
    if (override === 'doc') return true;
    if (override === 'container') return false;
    return !isStandalone();
  } catch {
    return false;
  }
}

/**
 * Reflect the JS decision into CSS-land: `<html data-scroll="doc">` gates the
 * few document-mode rules (body height, horizontal overflow) so the container
 * architecture keeps exactly the styles it had before.
 */
export function applyDocScrollState(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (enabled) root.setAttribute('data-scroll', 'doc');
  else root.removeAttribute('data-scroll');
}

/**
 * Height of the pinned app chrome (safe-area strip + server switcher) in
 * document mode. App publishes it as the `--frirss-chrome-top-h` custom
 * property; consumers of viewport-anchored offsets (sticky list header,
 * mark-as-read observer rootMargin, reading progress line) read it here.
 * Document parsing of a CSS custom property never reflows in Safari — safe
 * to call at any point.
 */
export function chromeTopHeight(): number {
  if (typeof document === 'undefined') return 0;
  const v = document.documentElement.style.getPropertyValue('--frirss-chrome-top-h');
  const px = parseFloat(v);
  return Number.isFinite(px) && px > 0 ? px : 0;
}

/**
 * Publishes the observed height of the pinned top chrome as
 * `--frirss-chrome-top-h` on `<html>`, and observes further changes
 * (server bar toggled, rotation). Returns a disposer.
 */
export function observeChromeTopHeight(
  getEl: () => HTMLElement | null,
  onTopOffsetPublish?: (height: number) => void,
): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {};
  let ro: ResizeObserver | null = null;
  const sync = () => {
    const el = getEl();
    if (!el) return;
    const h = Math.round(el.getBoundingClientRect().height);
    document.documentElement.style.setProperty('--frirss-chrome-top-h', `${h}px`);
    onTopOffsetPublish?.(h);
  };
  ro = new ResizeObserver(sync);
  const target = getEl();
  if (target) ro.observe(target);
  sync();
  return () => {
    ro?.disconnect();
    ro = null;
  };
}

/**
 * The scroller that owns vertical scrolling in the current mode. Container
 * mode → the list element itself; document mode → the root scrolling element
 * (works for both `documentElement`- and `body`-scrolling engines).
 */
export function getScroller(
  fallback: HTMLElement | null,
  docMode: boolean,
): HTMLElement | null {
  if (!docMode) return fallback;
  const el = document.scrollingElement ?? document.documentElement;
  return (el instanceof HTMLElement ? el : null) ?? fallback ?? null;
}

/** Scroll a scroller to an absolute offset, in either mode. */
export function scrollToScroller(
  fallback: HTMLElement | null,
  docMode: boolean,
  top: number,
  behavior?: ScrollBehavior,
): void {
  const el = fallback;
  if (!docMode) {
    el?.scrollTo({ top, behavior });
    return;
  }
  const scroller = getScroller(null, true);
  if (scroller) scroller.scrollTo({ top, behavior });
  else window.scrollTo({ top, behavior });
}

/**
 * Publishes which MobileStack layer owns the document scroller. The article
 * list reads this before writing its scroll memory or its overflow channel —
 * while the reading pane scrolls the DOCUMENT, window scroll events must not
 * be mistaken for list scrolling (they would corrupt the list's saved
 * position).
 */
export type MobileStackPhase = 'list' | 'reading';

export function setMobileStackPhase(phase: MobileStackPhase): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.mobileStack = phase;
}

export function isMobileStackReading(): boolean {
  return document.documentElement.dataset.mobileStack === 'reading';
}

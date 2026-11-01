// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  docScrollEnabled,
  applyDocScrollState,
  observeChromeTopHeight,
  getScroller,
  setMobileStackPhase,
  isMobileStackReading,
} from './docScrollMode';

describe('docScrollEnabled gating', () => {
  const originalNavigator = window.navigator;

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(display-mode: standalone)' ? false : false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    (window as unknown as { navigator: Navigator }).navigator = originalNavigator;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (window as unknown as { navigator: Navigator }).navigator = originalNavigator;
  });

  it('is enabled in a browser tab (not standalone, no override)', () => {
    expect(docScrollEnabled()).toBe(true);
  });

  it('is disabled when running standalone (installed PWA)', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(display-mode: standalone)' }));
    (window as unknown as { navigator: unknown }).navigator = { standalone: false };
    expect(docScrollEnabled()).toBe(false);
  });

  it('is disabled when iOS navigator.standalone is true', () => {
    (window as unknown as { navigator: unknown }).navigator = { standalone: true };
    expect(docScrollEnabled()).toBe(false);
  });

  it('?scroll=doc overrides standalone', () => {
    window.history.replaceState({}, '', '?scroll=doc');
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(display-mode: standalone)' }));
    expect(docScrollEnabled()).toBe(true);
  });

  it('?scroll=container overrides a browser tab', () => {
    window.history.replaceState({}, '', '?scroll=container');
    expect(docScrollEnabled()).toBe(false);
    // And the override is cached so a pushState removal keeps the choice.
    window.history.replaceState({}, '', '?other=1');
    expect(docScrollEnabled()).toBe(false);
  });

  it('applyDocScrollState mirrors the decision into the html attribute', () => {
    applyDocScrollState(true);
    expect(document.documentElement.dataset.scroll).toBe('doc');
    applyDocScrollState(false);
    expect(document.documentElement.dataset.scroll).toBeUndefined();
  });

  it('setMobileStackPhase / isMobileStackReading round-trip', () => {
    setMobileStackPhase('reading');
    expect(isMobileStackReading()).toBe(true);
    setMobileStackPhase('list');
    expect(isMobileStackReading()).toBe(false);
  });

  it('getScroller prefers the document scroller in doc mode', () => {
    const el = {};
    expect(getScroller(el as HTMLElement, false)).toBe(el);
    const doc = getScroller(null, true);
    expect(doc === document.scrollingElement || doc === document.documentElement).toBe(true);
  });

  it('observeChromeTopHeight publishes the measured chrome height', async () => {
    let observerCb: ResizeObserverCallback | null = null;
    const roInstance = {
      observe: () => {},
      disconnect: () => {},
      unobserve: () => {},
    };
    const RO = vi.fn((_cb: ResizeObserverCallback) => {
      observerCb = _cb;
      return roInstance;
    }) as unknown as typeof ResizeObserver;
    vi.stubGlobal('ResizeObserver', RO);

    const probe = document.createElement('div');
    document.body.appendChild(probe);
    Object.defineProperty(probe, 'getBoundingClientRect', {
      value: () => ({ height: 57.6, top: 0, left: 0, width: 100, bottom: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) }),
    });

    const disposed = observeChromeTopHeight(() => probe);
    // Initial sync publishes the measured height (rounded).
    expect(document.documentElement.style.getPropertyValue('--frirss-chrome-top-h')).toBe('58px');

    // A resize callback re-publishes.
    (observerCb as unknown as ResizeObserverCallback)([] as unknown as ResizeObserverEntry[], roInstance as unknown as ResizeObserver);
    expect(document.documentElement.style.getPropertyValue('--frirss-chrome-top-h')).toBe('58px');

    disposed();
    document.body.removeChild(probe);
    document.documentElement.style.removeProperty('--frirss-chrome-top-h');
    vi.unstubAllGlobals();
  });
});

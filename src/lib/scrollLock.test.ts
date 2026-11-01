// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lockBodyScroll } from './scrollLock';

/**
 * The freeze must be exact (§4.E): no background scroll while locked, no
 * jump on release. jsdom has no real scrolling engine, so the tests verify
 * the observable contract — body inline styles while frozen, the previous
 * inline styles restored on release, and a document scrolled back to the
 * saved offset unless nothing actually moved.
 */

let restoreWindow: () => void = () => {};
let scrollCalls: Array<[number, number]> = [];

/** Recorder for scrollTo + remote-controlled window.scrollY. */
function stageWindowScroll() {
  scrollCalls = [];
  const scrollToDesc = Object.getOwnPropertyDescriptor(window, 'scrollTo');
  const scrollYDesc = Object.getOwnPropertyDescriptor(window, 'scrollY');
  let y = 0;
  Object.defineProperty(window, 'scrollTo', {
    configurable: true,
    value: (x: number, top: number) => { scrollCalls.push([x, top]); },
  });
  Object.defineProperty(window, 'scrollY', {
    configurable: true,
    get: () => y,
    set: (v: number) => { y = v; },
  });
  restoreWindow = () => {
    if (scrollToDesc) Object.defineProperty(window, 'scrollTo', scrollToDesc);
    if (scrollYDesc) Object.defineProperty(window, 'scrollY', scrollYDesc);
    restoreWindow = () => {};
  };
}

describe('lockBodyScroll (overlay scroll freeze)', () => {
  beforeEach(() => {
    stageWindowScroll();
    document.body.removeAttribute('style');
  });

  afterEach(() => {
    document.body.removeAttribute('style');
    restoreWindow();
  });

  it('freezes the body at the current offset and restores the previous styles on release', () => {
    document.body.setAttribute('style', 'color: red');
    window.scrollY = 130;

    const unlock = lockBodyScroll();

    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.top).toBe('-130px');
    expect(document.body.style.width).toBe('100%');

    unlock();

    // The caller's own inline styles come back, not just cleared.
    expect(document.body.getAttribute('style')).toBe('color: red');
  });

  it('scrolls the document back to the saved offset on release when the page moved', () => {
    window.scrollY = 200;
    const unlock = lockBodyScroll();

    // Something (an iOS quirk, a focus jump) moved the document while frozen.
    window.scrollY = 40;
    unlock();

    expect(scrollCalls).toContainEqual([0, 200]);
  });

  it('does not scroll back when nothing moved (no-op release)', () => {
    window.scrollY = 90;
    const unlock = lockBodyScroll();
    unlock();

    expect(scrollCalls).toEqual([]);
    expect(document.body.getAttribute('style')).toBeNull();
  });

  it('counts depth: nested locks keep the freeze until the last one is released', () => {
    window.scrollY = 70;

    const unlockDrawer = lockBodyScroll();
    const unlockDialog = lockBodyScroll();

    unlockDrawer();

    // The drawer released but the dialog still holds the freeze.
    expect(document.body.style.position).toBe('fixed');
    expect(document.body.style.top).toBe('-70px');

    unlockDialog();

    expect(document.body.getAttribute('style')).toBeNull();
    expect(scrollCalls).toEqual([]);
  });
});

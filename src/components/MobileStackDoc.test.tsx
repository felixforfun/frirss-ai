// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import MobileStackDoc from './MobileStackDoc';

/**
 * The document-scrolling stack is verified structurally: which layer is in
 * flow, which is out of flow (no document height contribution), and that the
 * saved scroll offsets are captured/restored through window.scrollTo.
 * Real scrolling layout is verified on device (§7 of the brief) — jsdom has
 * no layout engine.
 *
 * Timing: the push/pop commit waits 400ms of animation; the tests wait
 * generously and the reduced-motion test flips the module mock to prove the
 * 40ms fast path. `prefersReducedMotion` is read at render time by
 * MobileStackDoc, so the hoisted mock flag is enough to drive both paths.
 */

const motion = vi.hoisted(() => ({ reduced: false }));
vi.mock('../lib/reducedMotion', () => ({ prefersReducedMotion: () => motion.reduced }));

const COMMIT_MS = 500; // > 400ms animated commit
const REDUCED_COMMIT_MS = 60; // > 40ms reduced commit

let restoreWindow: () => void = () => {};
let scrollCalls: Array<[number, number]> = [];

/** Replace jsdom's unimplemented scrollTo with a recorder + staged scrollY. */
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

function h(tag: string, text: string, lines = 40) {
  return React.createElement(tag, { key: text }, Array.from({ length: lines }, (_, i) => `${text} line ${i}`));
}

function stackProps() {
  return {
    base: <div data-testid="base">{h('p', 'list-sentinel')}</div>,
    overlay: <div data-testid="overlay">{h('p', 'reader-sentinel')}</div>,
  };
}

const fixedAncestor = (el: HTMLElement) => el.closest<HTMLElement>('[style*="position: fixed"]');

describe('MobileStackDoc (document-scrolling navigation stack)', () => {
  afterEach(() => {
    motion.reduced = false;
    delete document.documentElement.dataset.mobileStack;
    restoreWindow();
    cleanup();
  });

  it('keeps the base in flow on push, commits the reader, and restores the list position on pop', async () => {
    stageWindowScroll();
    const props = stackProps();
    const view = render(<MobileStackDoc {...props} showOverlay={false} />);

    // Initial: base in flow, no overlay.
    expect(screen.getByTestId('base')).toBeTruthy();
    expect(screen.queryByTestId('overlay')).toBeNull();
    expect(fixedAncestor(screen.getByTestId('base'))).toBeNull();

    // Simulate a mid-scroll push.
    window.scrollY = 742;
    view.rerender(<MobileStackDoc {...props} showOverlay />);

    // During 'pushing': the overlay mounts as a fixed viewport layer (it
    // animates, so the transform transition is inline), while the base stays
    // IN flow — the scrolled document must not jump.
    const overlay = screen.getByTestId('overlay');
    const overlayLayer = fixedAncestor(overlay);
    expect(overlayLayer).toBeTruthy();
    expect(overlayLayer!.getAttribute('style')).toContain('transition');
    expect(fixedAncestor(screen.getByTestId('base'))).toBeNull();
    expect(view.container.querySelector('[style*="display: none"]')).toBeNull();

    // After the commit timer: reader in flow, base hidden (contributes no
    // document height), document reset to the top for the reader.
    await new Promise((r) => setTimeout(r, COMMIT_MS));
    const readingOverlay = screen.getByTestId('overlay');
    expect(fixedAncestor(readingOverlay)).toBeNull();
    const hiddenBase = view.container.querySelector('[style*="display: none"]');
    expect(hiddenBase).toBeTruthy();
    expect(scrollCalls.at(-1)).toEqual([0, 0]);

    // Pop: the base returns to live flow AT POP START — the list becomes the
    // scrollable surface immediately, under the still-covering reader — and
    // the saved position is restored in the same synchronous commit.
    window.scrollY = 311;
    view.rerender(<MobileStackDoc {...props} showOverlay={false} />);

    // Base in flow (live), overlay fixed at the reader's own document offset.
    expect(fixedAncestor(screen.getByTestId('base'))).toBeNull();
    const poppingOverlay = fixedAncestor(screen.getByTestId('overlay'));
    expect(poppingOverlay).toBeTruthy();
    expect(poppingOverlay!.getAttribute('style')).toContain('calc(var(--frirss-chrome-top-h, 0px) - 311px)');
    expect(poppingOverlay!.getAttribute('style')).not.toContain('overflow: clip');
    // Restore happened synchronously with the pop render, not after a commit.
    expect(scrollCalls.at(-1)).toEqual([0, 742]);

    await new Promise((r) => setTimeout(r, COMMIT_MS));

    // Slide end: overlay unmounted, base untouched in flow, nothing else
    // re-scrolls (the list is already live where the user left it).
    expect(screen.getByTestId('base')).toBeTruthy();
    expect(fixedAncestor(screen.getByTestId('base'))).toBeNull();
    expect(screen.queryByTestId('overlay')).toBeNull();
    expect(scrollCalls.at(-1)).toEqual([0, 742]);
  });

  it('reports its phase for scrolling ownership (dataset on <html>)', async () => {
    stageWindowScroll();
    const props = stackProps();
    const view = render(<MobileStackDoc {...props} showOverlay={false} />);
    expect(document.documentElement.dataset.mobileStack).toBe('list');

    view.rerender(<MobileStackDoc {...props} showOverlay />);
    await new Promise((r) => setTimeout(r, COMMIT_MS));
    expect(document.documentElement.dataset.mobileStack).toBe('reading');

    view.rerender(<MobileStackDoc {...props} showOverlay={false} />);
    await new Promise((r) => setTimeout(r, COMMIT_MS));
    expect(document.documentElement.dataset.mobileStack).toBe('list');
  });

  it('keeps one stable DOM node per layer across phases (commits never re-mount subtrees)', async () => {
    stageWindowScroll();
    const props = stackProps();
    const view = render(<MobileStackDoc {...props} showOverlay={false} />);

    // The wrappers are style-hosts only — their identity must survive push,
    // reading, pop and slide-out, or a commit would rebuild whole subtrees.
    const baseBoxBefore = view.container.querySelector('[data-testid="base"]')!.parentElement!;

    window.scrollY = 900;
    view.rerender(<MobileStackDoc {...props} showOverlay />);
    await new Promise((r) => setTimeout(r, COMMIT_MS));
    const overlayBoxDuringRead = screen.getByTestId('overlay').parentElement!;

    // A fast push→pop cycle wraps around before the slide ends: the reader
    // wrapper keeps animating out while a new push begins on the same nodes.
    window.scrollY = 120;
    view.rerender(<MobileStackDoc {...props} showOverlay={false} />);
    const overlayBoxDuringPop = screen.getByTestId('overlay').parentElement!;

    await new Promise((r) => setTimeout(r, COMMIT_MS));
    const baseBoxAfter = view.container.querySelector('[data-testid="base"]')!.parentElement!;

    expect(baseBoxAfter).toBe(baseBoxBefore);
    expect(baseBoxBefore.getAttribute('style')).not.toContain('display: none');
    expect(overlayBoxDuringPop).toBe(overlayBoxDuringRead);
  });

  it('respects prefers-reduced-motion: same commits, no transition styles', async () => {
    stageWindowScroll();
    motion.reduced = true;
    const props = stackProps();
    const view = render(<MobileStackDoc {...props} showOverlay={false} />);

    window.scrollY = 55;
    view.rerender(<MobileStackDoc {...props} showOverlay />);

    // Pushing without animation: the sliding layers carry no inline
    // transition, the base stays live in flow as in the animated path.
    const overlayLayer = fixedAncestor(screen.getByTestId('overlay'));
    expect(overlayLayer).toBeTruthy();
    expect(overlayLayer!.getAttribute('style')).not.toContain('transition');
    expect(fixedAncestor(screen.getByTestId('base'))).toBeNull();

    // The reduced path commits much sooner (40ms timer).
    await new Promise((r) => setTimeout(r, REDUCED_COMMIT_MS));
    expect(document.documentElement.dataset.mobileStack).toBe('reading');
    expect(scrollCalls.at(-1)).toEqual([0, 0]);
  });
});

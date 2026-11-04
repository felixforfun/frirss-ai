// @vitest-environment jsdom
//
// Bottom action bar in DOCUMENT mode (mobile Safari browser tab).
//
// The bar used to be a `sticky bottom-0` child of the root scroller. On
// iOS Safari, that desyncs from the collapsing toolbars: the bar is painted
// at the new lower viewport edge while its touch region stays at the
// pre-collapse offset — the buttons were dead mid-article and only worked
// again once the toolbar re-expanded near the article top.
//
// The contract now: the bar is a FIXED viewport layer in both chrome states,
// and the article column reserves the bar's MEASURED height so the last
// paragraph scrolls clear of it. jsdom cannot reproduce the WebKit quirk —
// these tests pin the structure that removes it.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { Article } from '../../types';

// Mobile Safari browser tab: document scroller on a phone.
const docMode = { value: true, device: 'mobile' as const };
vi.mock('../../hooks/useDocScrollMode', () => ({ useDocScrollMode: () => docMode.value }));
vi.mock('../../hooks/useBreakpoint', () => ({ useBreakpoint: () => docMode.device }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));
vi.mock('../../api/feeds', () => ({
  getSubscriptionList: vi.fn(), getUnreadCounts: vi.fn(), getStreamContents: vi.fn(),
  getStarredItems: vi.fn(), markAsRead: vi.fn(() => Promise.resolve()),
  markAsUnread: vi.fn(() => Promise.resolve()), markAsStarred: vi.fn(() => Promise.resolve()),
  removeStarred: vi.fn(() => Promise.resolve()), markAllAsRead: vi.fn(() => Promise.resolve()),
  fetchStreamPage: vi.fn(), subscribeFeed: vi.fn(), editFeed: vi.fn(), unsubscribeFeed: vi.fn(),
  getTagList: vi.fn(), getStreamItemCount: vi.fn(), setArticleLabel: vi.fn(),
  renameTag: vi.fn(), deleteTag: vi.fn(), clearWriteToken: vi.fn(),
}));
vi.mock('../../api/backend', () => ({
  startActualize: vi.fn(), getActualizeStatus: vi.fn(),
  getAiSummaryConfig: vi.fn(() => Promise.resolve({ enabled: false, endpoint: '', model: '', prompt: '', hasApiKey: false })),
  summarizeArticle: vi.fn(),
}));
vi.mock('../../lib/offlineStore', () => ({
  listGet: vi.fn(() => Promise.resolve(undefined)), listPut: vi.fn(() => Promise.resolve()),
  listEvictOlderThan: vi.fn(() => Promise.resolve()), subsGet: vi.fn(() => Promise.resolve(undefined)),
  subsPut: vi.fn(() => Promise.resolve()), queueGet: vi.fn(() => Promise.resolve([])),
  queuePut: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../lib/extractStore', () => ({
  dbGet: vi.fn(() => Promise.resolve(undefined)), dbPut: vi.fn(() => Promise.resolve()),
  dbRecent: vi.fn(() => Promise.resolve([])), dbEvictOlderThan: vi.fn(() => Promise.resolve()),
  dbSetPinned: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../i18n', () => ({ default: { t: (k: string) => k } }));

import ReadingPane from './ReadingPane';
import { useFeedStore } from '../../stores/feedStore';

const article = {
  id: 'bar-1', title: 'Titre', summary: 's', source: 'Src', sourceId: 'feed/1',
  content: '<p>rss</p>', url: 'https://example.com/1', published: Date.now(),
  read: false, starred: false, labels: [],
} as unknown as Article;

/** jsdom has no ResizeObserver: a one-callback stub the test can fire. */
function stubResizeObserver(): { fire: () => void } {
  let cb: ResizeObserverCallback | null = null;
  const ro = class {
    constructor(callback: ResizeObserverCallback) { cb = callback; }
    observe() { /* measurements fire manually via fire() */ }
    disconnect() { cb = null; }
    unobserve() {}
  };
  vi.stubGlobal('ResizeObserver', ro);
  return { fire: () => { cb?.([], {} as ResizeObserver); } };
}

const articleOf = (container: HTMLElement) => container.querySelector('article.article-enter') as HTMLElement;

/**
 * jsdom's cssstyle silently drops `env(...)` values (and `touch-action`) from
 * inline styles, so the pre-measurement env fallback can't be read back.
 * Scope a fake bar box in instead and verify the contract that matters: the
 * measured bar height — read at mount and on every resize — lands in the
 * article column's reserved gutter.
 */
function withFakeBarBox(height: () => number): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.classList?.contains('reading-bottombar')) {
      return { height: height(), width: 390, top: 0, left: 0, right: 390, bottom: height(), x: 0, y: 0, toJSON: () => {} } as DOMRect;
    }
    return original.call(this);
  };
  return () => { HTMLElement.prototype.getBoundingClientRect = original; };
}

describe('ReadingPane — bottom action bar (document mode)', () => {
  beforeEach(() => { localStorage.clear(); docMode.value = true; });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); docMode.value = true; });

  it('mounts the bar as a fixed viewport layer — never a sticky scroller child', () => {
    useFeedStore.setState({ selectedArticle: article, articles: [article] } as never);
    const { container } = render(<ReadingPane />);

    const bar = container.querySelector('.reading-bottombar') as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.className).toContain('fixed bottom-0 inset-x-0 z-20');
    expect(bar.className).not.toContain('sticky');
  });

  it('reserves the measured bar height at the article column’s end', async () => {
    const ro = stubResizeObserver();
    let barH = 64;
    const restoreBox = withFakeBarBox(() => barH);
    try {
      useFeedStore.setState({ selectedArticle: article, articles: [article] } as never);
      const { container } = render(<ReadingPane />);
      await act(async () => { await Promise.resolve(); });

      // Measured at mount — the styled row plus its safe-area padding.
      const scroller = articleOf(container).parentElement as HTMLElement;
      expect(scroller.style.paddingBottom).toBe('64px');

      // Chrome/font-scale resizes re-measure through the ResizeObserver.
      barH = 80;
      await act(async () => { ro.fire(); await Promise.resolve(); });
      expect(scroller.style.paddingBottom).toBe('80px');
    } finally {
      restoreBox();
    }
  });

  it('container mode keeps the absolute bar with the reserved 52px gutter', () => {
    docMode.value = false;
    useFeedStore.setState({ selectedArticle: article, articles: [article] } as never);
    const { container } = render(<ReadingPane />);

    const bar = container.querySelector('.reading-bottombar') as HTMLElement;
    expect(bar.className).toContain('absolute bottom-0 inset-x-0 z-10');
    expect(bar.className).not.toContain('fixed');
    const scroller = articleOf(container).parentElement as HTMLElement;
    expect(scroller.style.paddingBottom).toBe('52px');
  });
});

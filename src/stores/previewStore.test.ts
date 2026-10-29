// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock feedStore BEFORE importing the preview store: a tiny fake zustand
// store is all `useFeedStore.getState()` needs.
vi.mock('../stores/feedStore', () => {
  const subscriptions: unknown[] = [];
  const selectView = vi.fn();
  const markAwaitingFirstArticles = vi.fn();
  const useFeedStore = { getState: () => ({ subscriptions, selectView, markAwaitingFirstArticles }) };
  return { useFeedStore };
});

vi.mock('../api/publisherPreview', () => ({
  fetchPublisherPreview: vi.fn(),
  discoverPublisherFeed: vi.fn(),
}));
vi.mock('../utils/sanitizeHtml', () => ({ sanitizeHtml: (s: string) => `clean:${s}` }));
vi.mock('../lib/canonicalArticle', () => ({
  isTechmemePermalinkUrl: vi.fn(),
  resolveCanonicalArticle: vi.fn(),
}));

import { usePreviewStore } from './previewStore';
import { useFeedStore } from '../stores/feedStore';
import { isTechmemePermalinkUrl, resolveCanonicalArticle } from '../lib/canonicalArticle';
import { fetchPublisherPreview, discoverPublisherFeed } from '../api/publisherPreview';
import type { Article, Subscription } from '../types';

const feedStoreState = useFeedStore.getState as unknown as () => { subscriptions: unknown[]; selectView: ReturnType<typeof vi.fn>; markAwaitingFirstArticles: ReturnType<typeof vi.fn> };

const sub = (id: string, url: string, htmlUrl: string): Subscription =>
  ({ id, title: id, url, htmlUrl });

const article = (over: Partial<Article> = {}): Article =>
  ({
    id: 'item/1', title: 'T', summary: '', content: '', author: '',
    url: 'https://publisher.example.org/a', source: 'Techmeme', sourceId: 'feed/https://www.techmeme.com/feed.xml',
    published: 0, read: false, starred: false, labels: [], tags: [],
    ...over,
  });

const previewResponse = { feed: { kind: 'rss' as const, title: 'The New Stack', siteUrl: 'https://thenewstack.io/', feedUrl: 'https://thenewstack.io/feed', selfUrl: '', iconUrl: '', description: '' }, articles: [{ id: 'a', title: 'A', url: 'https://thenewstack.io/a', published: 1, summary: '<i>x</i>', author: '' }] };

beforeEach(() => {
  vi.mocked(fetchPublisherPreview).mockResolvedValue(previewResponse);
  vi.mocked(discoverPublisherFeed).mockResolvedValue([{ href: 'https://thenewstack.io/feed', type: 'application/rss+xml', title: 'The New Stack' }]);
});

afterEach(() => {
  vi.clearAllMocks();
  usePreviewStore.getState().close();
  vi.mocked(isTechmemePermalinkUrl).mockReset();
  vi.mocked(resolveCanonicalArticle).mockReset();
});

describe('openPublisher', () => {
  it('navigates to the existing feed for a DIRECT subscription article', async () => {
    feedStoreState().subscriptions.length = 0;
    feedStoreState().subscriptions.push(sub('welt', 'https://www.welt.de/feeds/index.rss', 'https://www.welt.de/'));
    vi.mocked(isTechmemePermalinkUrl).mockReturnValue(false);

    await usePreviewStore.getState().openPublisher(article({ sourceId: 'feed/https://www.welt.de/feeds/index.rss', url: 'https://www.welt.de/politik' }));

    expect(feedStoreState().selectView).toHaveBeenCalledWith(expect.objectContaining({ id: 'welt' }));
    expect(usePreviewStore.getState().status).toBe('idle');
    expect(fetchPublisherPreview).not.toHaveBeenCalled();
  });

  it('navigates to the SAME-SITE subscription instead of previewing', async () => {
    feedStoreState().subscriptions.length = 0;
    feedStoreState().subscriptions.push(sub('newstack', 'https://thenewstack.io/feed', 'https://thenewstack.io'));
    vi.mocked(isTechmemePermalinkUrl).mockReturnValue(true);
    vi.mocked(resolveCanonicalArticle).mockResolvedValue({ url: 'https://thenewstack.io/a', publisher: 'thenewstack.io' } as never);

    await usePreviewStore.getState().openPublisher(article({ url: 'https://www.techmeme.com/261023/p28' }));

    expect(feedStoreState().selectView).toHaveBeenCalledWith(expect.objectContaining({ id: 'newstack' }));
    expect(fetchPublisherPreview).not.toHaveBeenCalled();
  });

  it('opens the preview for an UNsubscribed resolved publisher', async () => {
    feedStoreState().subscriptions.length = 0;
    vi.mocked(isTechmemePermalinkUrl).mockReturnValue(true);
    vi.mocked(resolveCanonicalArticle).mockResolvedValue({ url: 'https://thenewstack.io/a', publisher: 'thenewstack.io' } as never);

    await usePreviewStore.getState().openPublisher(article({ url: 'https://www.techmeme.com/261023/p28' }));

    expect(usePreviewStore.getState().status).toBe('ready');
    expect(usePreviewStore.getState().articles[0]).toEqual(expect.objectContaining({ id: 'a', summary: 'clean:<i>x</i>' }));
    expect(feedStoreState().selectView).not.toHaveBeenCalled();
  });

  it('errors with a recoverable key when discovery finds NO feed', async () => {
    feedStoreState().subscriptions.length = 0;
    vi.mocked(isTechmemePermalinkUrl).mockReturnValue(true);
    vi.mocked(resolveCanonicalArticle).mockResolvedValue({ url: 'https://obscure.example.org/a', publisher: 'obscure.example.org' } as never);
    vi.mocked(discoverPublisherFeed).mockResolvedValue([]);

    await usePreviewStore.getState().openPublisher(article());

    expect(usePreviewStore.getState().status).toBe('error');
    expect(usePreviewStore.getState().errorKey).toBe('preview.errorResolveFailed');
  });

  it('asks the user to choose when the site declares SEVERAL feeds', async () => {
    feedStoreState().subscriptions.length = 0;
    vi.mocked(isTechmemePermalinkUrl).mockReturnValue(true);
    vi.mocked(resolveCanonicalArticle).mockResolvedValue({ url: 'https://multi.example.org/a', publisher: 'multi.example.org' } as never);
    vi.mocked(discoverPublisherFeed).mockResolvedValue([
      { href: 'https://multi.example.org/atom.xml', type: 'application/atom+xml', title: 'News' },
      { href: 'https://multi.example.org/community.xml', type: 'application/rss+xml', title: 'Community' },
    ]);

    await usePreviewStore.getState().openPublisher(article());

    expect(usePreviewStore.getState().status).toBe('choose');
    expect(fetchPublisherPreview).not.toHaveBeenCalled();
    // Choosing explicitly loads the picked feed.
    usePreviewStore.getState().openFeed('https://multi.example.org/atom.xml', 'News');
    await vi.waitFor(() => expect(usePreviewStore.getState().status).toBe('ready'));
  });

  it('auto-selects the article feed when the only extra candidate is a COMMENTS feed (WordPress sites)', async () => {
    feedStoreState().subscriptions.length = 0;
    vi.mocked(isTechmemePermalinkUrl).mockReturnValue(true);
    vi.mocked(resolveCanonicalArticle).mockResolvedValue({ url: 'https://ofdollarsanddata.com/a', publisher: 'ofdollarsanddata.com' } as never);
    vi.mocked(discoverPublisherFeed).mockResolvedValue([
      { href: 'https://ofdollarsanddata.com/feed/', type: 'application/rss+xml', title: 'Of Dollars And Data » Feed' },
      { href: 'https://ofdollarsanddata.com/comments/feed/', type: 'application/rss+xml', title: 'Of Dollars And Data » Comments Feed' },
    ]);

    await usePreviewStore.getState().openPublisher(article());

    // Not a `choose` state: the only meaningful feed is picked directly.
    expect(fetchPublisherPreview).toHaveBeenCalledWith('https://ofdollarsanddata.com/feed/');
    await vi.waitFor(() => expect(usePreviewStore.getState().status).toBe('ready'));
  });

  it('falls back to error (retryable) when the preview fetch fails', async () => {
    feedStoreState().subscriptions.length = 0;
    vi.mocked(isTechmemePermalinkUrl).mockReturnValue(true);
    vi.mocked(resolveCanonicalArticle).mockResolvedValue({ url: 'https://thenewstack.io/a', publisher: 'thenewstack.io' } as never);
    vi.mocked(fetchPublisherPreview).mockRejectedValue(new Error('boom'));

    await usePreviewStore.getState().openPublisher(article());

    expect(usePreviewStore.getState().status).toBe('error');
    expect(usePreviewStore.getState().errorKey).toBe('preview.errorLoad');
  });

  it('errors when the article has NO resolvable identity at all', async () => {
    feedStoreState().subscriptions.length = 0;
    vi.mocked(isTechmemePermalinkUrl).mockReturnValue(false);

    await usePreviewStore.getState().openPublisher(article({ sourceId: 'feed/https://unknown.example.org/feed' }));

    expect(usePreviewStore.getState().status).toBe('error');
    expect(usePreviewStore.getState().errorKey).toBe('preview.errorUnresolved');
  });
});

describe('navigateToSubscription', () => {
  it('selects the subscription matching the feed URL, whatever its scheme/port', async () => {
    feedStoreState().subscriptions.length = 0;
    feedStoreState().subscriptions.push(sub('n', 'http://thenewstack.io:80/feed', 'https://thenewstack.io'));

    const ok = await usePreviewStore.getState().navigateToSubscription('https://thenewstack.io/feed');

    expect(ok).toBe(true);
    expect(feedStoreState().selectView).toHaveBeenCalledWith(expect.objectContaining({ id: 'n' }));
    expect(usePreviewStore.getState().status).toBe('idle');
  });

  it('refuses when nothing matches (never fabricates a navigation)', async () => {
    feedStoreState().subscriptions.length = 0;
    feedStoreState().selectView.mockClear();
    const ok = await usePreviewStore.getState().navigateToSubscription('https://not-there.example.org/feed');
    expect(ok).toBe(false);
    expect(feedStoreState().selectView).not.toHaveBeenCalled();
  });
});

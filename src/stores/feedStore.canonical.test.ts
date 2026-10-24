// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { Article } from '../types';

vi.mock('../api/feeds', () => ({
  getSubscriptionList: vi.fn(), getUnreadCounts: vi.fn(), getStreamContents: vi.fn(),
  getStarredItems: vi.fn(), markAsRead: vi.fn(() => Promise.resolve()),
  markAsUnread: vi.fn(() => Promise.resolve()), markAsStarred: vi.fn(() => Promise.resolve()),
  removeStarred: vi.fn(() => Promise.resolve()), markAllAsRead: vi.fn(() => Promise.resolve()),
  getUnreadItemIds: vi.fn(), fetchStreamPage: vi.fn(), subscribeFeed: vi.fn(),
  editFeed: vi.fn(), unsubscribeFeed: vi.fn(), getTagList: vi.fn(),
  getStreamItemCount: vi.fn(), setArticleLabel: vi.fn(), renameTag: vi.fn(),
  deleteTag: vi.fn(), clearWriteToken: vi.fn(), itemIdsNewerThanEntry: vi.fn(),
}));

vi.mock('../api/backend', () => ({
  startActualize: vi.fn(), getActualizeStatus: vi.fn(),
  getInfrequentFeedCache: vi.fn(), saveInfrequentFeedCache: vi.fn(),
  resolveTechmemeArticleUrl: vi.fn(),
}));

vi.mock('../lib/offlineStore', () => ({
  listGet: vi.fn(() => Promise.resolve(undefined)), listPut: vi.fn(() => Promise.resolve()),
  listEvictOlderThan: vi.fn(() => Promise.resolve()), subsGet: vi.fn(() => Promise.resolve(undefined)),
  subsPut: vi.fn(() => Promise.resolve()), queueGet: vi.fn(() => Promise.resolve([])),
  queuePut: vi.fn(() => Promise.resolve()),
}));

vi.mock('../i18n', () => ({ default: { t: (k: string) => k } }));

import { useFeedStore } from './feedStore';
import { resolveTechmemeArticleUrl } from '../api/backend';
const resolvable = vi.mocked(resolveTechmemeArticleUrl);

const techmeme = (id: string, extra: Partial<Article> = {}): Article => ({
  id, title: `Story ${id}`, summary: '', content: '', author: '',
  url: 'https://www.techmeme.com/261023/p28#a261023p28',
  source: 'Techmeme', sourceId: 'feed/398', published: 1, read: false, starred: false, labels: [], tags: [],
  ...extra,
}) as Article;

const normal: Article = {
  id: 'r1', title: 'Regular', summary: '', content: '', author: '',
  url: 'https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/',
  source: 'Android Authority', sourceId: 'feed/1', published: 1, read: false, starred: false, labels: [], tags: [],
};

beforeAll(() => {
  useFeedStore.setState({ articles: [], selectedArticle: null });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyCanonicalUrl', () => {
  it('writes a distinct canonicalUrl on list, selection and search corpus without touching identity fields', () => {
    useFeedStore.setState({
      articles: [techmeme('e1'), normal],
      selectedArticle: techmeme('e1'),
    });
    useFeedStore.getState().applyCanonicalUrl('e1', 'https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/');
    const updated = useFeedStore.getState();
    expect(updated.articles[0]?.canonicalUrl).toBe('https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/');
    expect(updated.selectedArticle?.canonicalUrl).toBe('https://www.androidauthority.com/google-personal-intelligence-privacy-3727111/');
    // Identity provenance intact: FreshRSS id, feed source and URL untouched.
    expect(updated.articles[0]?.source).toBe('Techmeme');
    expect(updated.articles[0]?.url).toContain('techmeme.com');
    expect(updated.articles[0]?.id).toBe('e1');
    expect(updated.articles[1]?.canonicalUrl).toBeUndefined();
  });

  it('is idempotent: re-applying the same canonical URL changes nothing', () => {
    useFeedStore.setState({
      articles: [techmeme('e2')],
      selectedArticle: null,
    });
    useFeedStore.getState().applyCanonicalUrl('e2', 'https://www.reuters.com/stories/tech/x');
    const before = useFeedStore.getState().articles[0];
    useFeedStore.getState().applyCanonicalUrl('e2', 'https://www.reuters.com/stories/tech/x');
    expect(useFeedStore.getState().articles[0]).toBe(before); // même référence — rien réécrit
    expect(useFeedStore.getState().articles).toHaveLength(1); // pas de doublon
  });
});

describe('primeCanonicalArticle', () => {
  it('does nothing for non-Techmeme articles', () => {
    useFeedStore.setState({ articles: [normal], selectedArticle: null });
    useFeedStore.getState().primeCanonicalArticle(normal);
    expect(resolvable).not.toHaveBeenCalled();
    expect(useFeedStore.getState().articles[0]?.canonicalUrl).toBeUndefined();
  });

  it('resolves a Techmeme item and writes the publisher URL through the store', async () => {
    resolvable.mockResolvedValueOnce('https://www.bbc.com/news/articles/cqdjv8xllvyyo');
    useFeedStore.setState({ articles: [techmeme('e3')], selectedArticle: null });
    useFeedStore.getState().primeCanonicalArticle(useFeedStore.getState().articles[0]!);
    await vi.waitFor(() => {
      expect(useFeedStore.getState().articles[0]?.canonicalUrl).toBe('https://www.bbc.com/news/articles/cqdjv8xllvyyo');
    });
    // Résolu une fois : la même demande rejouée ne rappelle pas l'API.
    // (l'article patché porte déjà canonicalUrl, le garde prime s'arrête)
    useFeedStore.getState().primeCanonicalArticle(useFeedStore.getState().articles[0]!);
    expect(resolvable).toHaveBeenCalledTimes(1);
  });

  it('does not retry a failed Techmeme resolution within the session', async () => {
    resolvable.mockResolvedValueOnce(null);
    // Chemin unique : la mémoire de résolution (par chemin) est partagée par
    // le module — un item déjà résolu par un test précédent éviterait l'API.
    useFeedStore.setState({ articles: [techmeme('e4', { url: 'https://www.techmeme.com/261023/p27#a261023p27' })], selectedArticle: null });
    useFeedStore.getState().primeCanonicalArticle(useFeedStore.getState().articles[0]!);
    await vi.waitFor(() => expect(resolvable).toHaveBeenCalledTimes(1));
    useFeedStore.getState().primeCanonicalArticle(useFeedStore.getState().articles[0]!);
    expect(resolvable).toHaveBeenCalledTimes(1); // attempted-set, pas de boucle
    expect(useFeedStore.getState().articles[0]?.canonicalUrl).toBeUndefined();
  });

  it('selection fires the prime and lands the canonical URL on the selected article', async () => {
    resolvable.mockResolvedValueOnce('https://www.theinformation.com/briefings/aws-sold-capacity-2028-jassy-says');
    useFeedStore.setState({ articles: [techmeme('e5', { url: 'https://www.techmeme.com/261023/p26#a261023p26' })], selectedArticle: null });
    useFeedStore.getState().selectArticle(useFeedStore.getState().articles[0]!);
    await vi.waitFor(() => {
      expect(useFeedStore.getState().selectedArticle?.canonicalUrl).toBe('https://www.theinformation.com/briefings/aws-sold-capacity-2028-jassy-says');
    });
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hackerNewsDiscussionUrl, hackerNewsItemIdFromContent, hackerNewsItemIdFromUrl, isHackerNewsArticle, resolveDiscussion } from './hackerNews';
import type { Article } from '../types';

// `hackerNews.ts` importe le client backend (résolution serveur) : doublé ici
// pour que ce test tourne hors navigateur, comme `canonicalArticle.test.ts`.
vi.mock('../api/backend', () => ({
  resolveHackerNewsDiscussionUrl: vi.fn(),
}));

import { resolveHackerNewsDiscussionUrl } from '../api/backend';
const fetchDiscussion = vi.mocked(resolveHackerNewsDiscussionUrl);

beforeEach(() => {
  fetchDiscussion.mockReset();
});

const article = (over: Partial<Article>): Article => ({
  id: 'a1', title: 'Titre', summary: '', content: '', source: 'Hacker News',
  url: '', published: Date.now(), read: false, starred: false, labels: [],
  ...over,
} as unknown as Article);

describe('hackerNewsItemIdFromUrl', () => {
  it('retire l’identifiant d’une URL item officielle, www ou non', () => {
    expect(hackerNewsItemIdFromUrl('https://news.ycombinator.com/item?id=50326727')).toBe('50326727');
    expect(hackerNewsItemIdFromUrl('https://www.news.ycombinator.com/item?id=42')).toBe('42');
    expect(hackerNewsItemIdFromUrl('http://news.ycombinator.com/item?id=1')).toBe('1');
  });

  it('rejette tout le reste', () => {
    for (const url of [
      'https://news.ycombinator.com',
      'https://news.ycombinator.com/news',
      'https://news.ycombinator.com/item?id=',
      'https://news.ycombinator.com/item?id=abc',
      'https://www.tomshardware.com/a-story',
      'https://github.com/ivankovic/omnidiff',
      'https://news.ycombinator.com/item/Xid=50326727',
      'https://hnrss.org/item?id=50326727',
      '',
    ]) {
      expect(hackerNewsItemIdFromUrl(url), url).toBeNull();
    }
    expect(hackerNewsItemIdFromUrl(undefined)).toBeNull();
  });
});

describe('hackerNewsItemIdFromContent', () => {
  it('retire l’identifiant de l’ancre « Comments » du flux', () => {
    const anchor = '<a href="https://news.ycombinator.com/item?id=50326821">Comments</a>';
    expect(hackerNewsItemIdFromContent(anchor)).toBe('50326821');
  });

  it('rejette un contenu sans identifiant — l’extraction af-readability, typiquement', () => {
    expect(hackerNewsItemIdFromContent('<article><p>Texte de l’éditeur.</p></article>')).toBeNull();
    expect(hackerNewsItemIdFromContent('<a href="https://hackernews.example/item?id=99">Comments</a>')).toBeNull();
    expect(hackerNewsItemIdFromContent('')).toBeNull();
    expect(hackerNewsItemIdFromContent(undefined)).toBeNull();
  });

  it('lit la première occurrence qui existe', () => {
    const html = '<a href="https://news.ycombinator.com/item?id=7">a</a><a href="https://news.ycombinator.com/item?id=8">b</a>';
    expect(hackerNewsItemIdFromContent(html)).toBe('7');
  });
});

describe('isHackerNewsArticle', () => {
  it('reconnaît le flux par son titre de source', () => {
    expect(isHackerNewsArticle(article({ source: 'Hacker News', url: 'https://example.com/x' }))).toBe(true);
    expect(isHackerNewsArticle(article({ source: 'Hacker News Daily' }))).toBe(true);
  });

  it('reconnaît aussi un article pointant lui-même vers news.ycombinator.com', () => {
    expect(isHackerNewsArticle(article({ source: 'Techmeme', url: 'https://news.ycombinator.com/item?id=50326727' }))).toBe(true);
  });

  it('rejette les autres flux', () => {
    expect(isHackerNewsArticle(article({ source: 'Techmeme', url: 'https://www.techmeme.com/261023/p28' }))).toBe(false);
    expect(isHackerNewsArticle(article({ source: 'News', url: 'https://example.com/x' }))).toBe(false);
  });
});

describe('hackerNewsDiscussionUrl', () => {
  it('construit l’URL officielle item?id=… depuis l’ancre du contenu', () => {
    const a = article({
      url: 'https://hackerbooks.org',
      content: '<a href="https://news.ycombinator.com/item?id=50326821">Comments</a>',
    });
    expect(hackerNewsDiscussionUrl(a)).toBe('https://news.ycombinator.com/item?id=50326821');
  });

  it('construit l’URL depuis une `url` déjà pointant vers l’item HN', () => {
    const a = article({ url: 'https://news.ycombinator.com/item?id=50326727', content: '' });
    expect(hackerNewsDiscussionUrl(a)).toBe('https://news.ycombinator.com/item?id=50326727');
  });

  it('ne déduit RIEN quand l’identifiant est perdu (contenu extrait sans ancre)', () => {
    const a = article({
      source: 'Hacker News',
      url: 'https://lagomor.ph/2026/10/the-ground-beneath-them-was-dry/',
      content: '<article><p>Article complet extrait par af-readability.</p></article>',
    });
    expect(hackerNewsDiscussionUrl(a)).toBeNull();
  });

  it('ne déduit rien d’un flux non HN, même si son contenu cite HN', () => {
    const a = article({
      source: 'Marginal REVOLUTION',
      url: 'https://marginalrevolution.com/x',
      content: '<a href="https://news.ycombinator.com/item?id=50326727">discussion</a>',
    });
    expect(hackerNewsDiscussionUrl(a)).toBeNull();
  });

  it('canonicalise une URL item triviale (www, http)', () => {
    const a = article({ url: 'http://www.news.ycombinator.com/item?id=1' });
    expect(hackerNewsDiscussionUrl(a)).toBe('https://news.ycombinator.com/item?id=1');
  });
});

describe('resolveDiscussion', () => {
  it('résout un article du flux HN dont l’identifiant a été perdu', async () => {
    fetchDiscussion.mockResolvedValueOnce('https://news.ycombinator.com/item?id=50330000');
    const url = await resolveDiscussion('https://lagomor.ph/2026/10/the-ground-beneath-them-was-dry/', fetchDiscussion);
    expect(url).toBe('https://news.ycombinator.com/item?id=50330000');
    expect(fetchDiscussion).toHaveBeenCalledTimes(1);
  });

  it('ne résout jamais deux fois le même story (mémoire partagée)', async () => {
    fetchDiscussion.mockResolvedValue('https://news.ycombinator.com/item?id=50330001');
    await resolveDiscussion('https://lagomor.ph/2026/10/another-story/', fetchDiscussion);
    const second = await resolveDiscussion('https://lagomor.ph/2026/10/another-story/', fetchDiscussion);
    expect(second).toBe('https://news.ycombinator.com/item?id=50330001');
    expect(fetchDiscussion).toHaveBeenCalledTimes(1);
  });

  it('partage un appel en vol entre appels concurrents', async () => {
    fetchDiscussion.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve('https://news.ycombinator.com/item?id=42'), 10)));
    const [a, b] = await Promise.all([
      resolveDiscussion('https://concurrent.example/post', fetchDiscussion),
      resolveDiscussion('https://concurrent.example/post', fetchDiscussion),
    ]);
    expect(a).toBe('https://news.ycombinator.com/item?id=42');
    expect(b).toBe('https://news.ycombinator.com/item?id=42');
    expect(fetchDiscussion).toHaveBeenCalledTimes(1);
  });

  it('ignore les variantes www/fragment/tracking d’une même story', async () => {
    fetchDiscussion.mockResolvedValue('https://news.ycombinator.com/item?id=7');
    await resolveDiscussion('https://www.example.com/post', fetchDiscussion);
    await resolveDiscussion('https://example.com/post?utm_source=rss', fetchDiscussion);
    expect(fetchDiscussion).toHaveBeenCalledTimes(1);
  });

  it('mémorise un échec pour la session (pas de boucle de retries)', async () => {
    fetchDiscussion.mockRejectedValueOnce(new Error('network down'));
    expect(await resolveDiscussion('https://failing.example/post', fetchDiscussion)).toBeNull();
    expect(await resolveDiscussion('https://failing.example/post', fetchDiscussion)).toBeNull();
    expect(fetchDiscussion).toHaveBeenCalledTimes(1);
  });
});

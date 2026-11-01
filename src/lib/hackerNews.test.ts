import { describe, it, expect } from 'vitest';
import { hackerNewsDiscussionUrl, hackerNewsItemIdFromContent, hackerNewsItemIdFromUrl, isHackerNewsArticle } from './hackerNews';
import type { Article } from '../types';

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

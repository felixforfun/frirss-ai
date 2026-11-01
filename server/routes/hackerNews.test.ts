import { describe, it, expect, vi, afterEach, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Express, Request, Response, NextFunction } from 'express';
import db from '../db.js';
import { storyKey, sameStoryUrl, isResolvableStoryUrl, resolveFromAlgolia } from './hackerNews.js';

// Mount trick from `techmeme.test.ts`: replace the JWT middleware so the route
// is reachable without a session.
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: unknown }).user = { id: 1, username: 'tester', role: 'user', email: '', display_name: '', active: 1, auth_provider: 'local' };
    next();
  },
  requireAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Algolia responses: hits with objectID + url. A response is ONLY trusted when
// one of the hits carries the EXACT story URL — never the first hit blindly.
function algoliaResponse(hits: Array<{ objectID: string; url?: string | null }>): typeof fetch {
  return vi.fn(async () => new Response(
    JSON.stringify({ hits }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as unknown as typeof fetch;
}

const STORY = 'https://www.somesite.dev/blog/the-post';
const HN_HIT = { objectID: '51432000', url: 'https://www.somesite.dev/blog/the-post' };
const WWW_HIT = { objectID: '51432001', url: 'https://somesite.dev/blog/the-post' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storyKey', () => {
  it('normalizes host (www), trailing slash, fragment and query order', () => {
    expect(storyKey('https://www.somesite.dev/blog/the-post?utm=1#top'))
      .toBe(storyKey('https://somesite.dev/blog/the-post?utm=1'));
    expect(storyKey('https://somesite.dev/blog/the-post?b=2&a=1'))
      .toBe(storyKey('https://somesite.dev/blog/the-post?a=1&b=2'));
  });

  it('keeps distinct stories distinct', () => {
    expect(storyKey('https://somesite.dev/blog/the-post'))
      .not.toBe(storyKey('https://somesite.dev/blog/other-post'));
  });

  it('returns null for garbage and non-http schemes', () => {
    expect(storyKey('not a URL')).toBeNull();
    expect(storyKey('ftp://somesite.dev/post')).toBeNull();
  });
});

describe('sameStoryUrl', () => {
  it('accepts protocol, www and fragment variants of the same story', () => {
    expect(sameStoryUrl('https://www.somesite.dev/blog/the-post', 'http://somesite.dev/blog/the-post#top')).toBe(true);
  });

  it('rejects a different story even from the same hit list', () => {
    expect(sameStoryUrl(HN_HIT.url!, 'https://www.somesite.dev/blog/the-other-post')).toBe(false);
  });
});

describe('isResolvableStoryUrl', () => {
  it('accepts ordinary publisher URLs', () => {
    expect(isResolvableStoryUrl(STORY)).toBe(true);
  });

  it('rejects HN items themselves (nothing to resolve) and garbage', () => {
    expect(isResolvableStoryUrl('https://news.ycombinator.com/item?id=50326727')).toBe(false);
    expect(isResolvableStoryUrl('https://www.news.ycombinator.com/item?id=50326727')).toBe(false);
    expect(isResolvableStoryUrl('not a URL')).toBe(false);
  });
});

describe('resolveFromAlgolia', () => {
  it('returns the official item URL when a hit carries the exact story URL', async () => {
    expect(await resolveFromAlgolia(STORY, algoliaResponse([HN_HIT])))
      .toBe('https://news.ycombinator.com/item?id=51432000');
  });

  it('matches hit URLs that differ only by protocol/www/fragment', async () => {
    expect(await resolveFromAlgolia(STORY, algoliaResponse([WWW_HIT])))
      .toBe('https://news.ycombinator.com/item?id=51432001');
  });

  it('NEVER trusts a hit whose url is another story (first hit, empty url, null url)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await resolveFromAlgolia(STORY, algoliaResponse([
      { objectID: '111', url: 'https://www.somesite.dev/blog/the-other-post' },
      { objectID: '222', url: '' },
      { objectID: '333', url: null },
      { objectID: '444', url: 'https://somesite.dev/blog/the-post' },
    ]))).toBe('https://news.ycombinator.com/item?id=444');
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns null (negative) when no hit carries the exact URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await resolveFromAlgolia(STORY, algoliaResponse([
      { objectID: '111', url: 'https://www.somesite.dev/blog/the-other-post' },
    ]))).toBeNull();
    expect(warn).toHaveBeenCalledWith('[hackerNews] resolve miss: no Algolia hit carries the exact story URL');
  });

  it('throws on a non-OK response so a transient failure is never cached as negative', async () => {
    const failing = vi.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch;
    await expect(resolveFromAlgolia(STORY, failing)).rejects.toThrow('algolia-unavailable');
  });

  it('throws on malformed JSON rather than resolving nothing', async () => {
    const broken = vi.fn(async () => new Response('<html>not json</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(resolveFromAlgolia(STORY, broken)).rejects.toThrow('algolia-invalid-json');
  });
});

// ── Route montée : auth stub + fetch stub + base isolée ────────────────
// Même motif que `techmeme.test.ts` : vi.resetModules() pour que chaque bloc
// charge la route avec son propre fetch doublé.
async function buildApp(): Promise<{ app: Express }> {
  vi.resetModules();
  const hackerNews = await import('./hackerNews.js');
  const app = express();
  app.use(express.json());
  app.use('/api/hacker-news', hackerNews.default);
  return { app };
}

describe('GET /hacker-news/resolve (persistent mapping)', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM hn_discussions').run();
    vi.stubGlobal('fetch', algoliaResponse([HN_HIT]) as unknown as typeof fetch);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  afterAll(() => {
    db.prepare('DELETE FROM hn_discussions').run();
  });

  it('stores the mapping on first hit and answers later requests from the table', async () => {
    const { app } = await buildApp();
    const first = await request(app).get(`/api/hacker-news/resolve?url=${encodeURIComponent(STORY)}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ url: 'https://news.ycombinator.com/item?id=51432000', cached: false });

    // L'appel réseau ne peut plus répondre : la table répond seule.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch);
    const second = await request(app).get(`/api/hacker-news/resolve?url=${encodeURIComponent(STORY)}`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ url: 'https://news.ycombinator.com/item?id=51432000', cached: true });
  });

  it('normalizes the request URL so www/fragment variants share one row', async () => {
    const { app } = await buildApp();
    await request(app).get(`/api/hacker-news/resolve?url=${encodeURIComponent(STORY)}`);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM hn_discussions WHERE url = ?').get('somesite.dev/blog/the-post') as { n: number };
    expect(rows.n).toBe(1);
    const variant = await request(app).get(`/api/hacker-news/resolve?url=${encodeURIComponent('https://www.somesite.dev/blog/the-post?utm=1')}`);
    expect(variant.body).toEqual({ url: 'https://news.ycombinator.com/item?id=51432000', cached: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM hn_discussions').get() as { n: number }).n).toBe(1);
  });

  it('caches a MISS as negative (nothing to return) but only for the TTL window', async () => {
    const { app } = await buildApp();
    const missStory = 'https://www.somesite.dev/blog/no-discussion';
    vi.stubGlobal('fetch', algoliaResponse([]) as unknown as typeof fetch);
    const first = await request(app).get(`/api/hacker-news/resolve?url=${encodeURIComponent(missStory)}`);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ url: null, cached: false });

    // Le fetch ne peut plus répondre : le négatif répond quand même.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch);
    const second = await request(app).get(`/api/hacker-news/resolve?url=${encodeURIComponent(missStory)}`);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ url: null, cached: true });
    const row = db.prepare('SELECT item_id FROM hn_discussions WHERE url = ?').get('somesite.dev/blog/no-discussion') as { item_id: string | null };
    expect(row.item_id).toBeNull();
  });

  it('answers 503 on a transient resolver failure and writes NOTHING to the table', async () => {
    const { app } = await buildApp();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }) as unknown as typeof fetch);
    const response = await request(app).get(`/api/hacker-news/resolve?url=${encodeURIComponent(STORY)}`);
    expect(response.status).toBe(503);
    expect((db.prepare('SELECT COUNT(*) AS n FROM hn_discussions').get() as { n: number }).n).toBe(0);
  });

  it('answers 400 for non-story URLs (HN items, garbage) without touching the resolver', async () => {
    const { app } = await buildApp();
    const fetchSpy = algoliaResponse([HN_HIT]);
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch);
    for (const url of ['https://news.ycombinator.com/item?id=50326727', 'not a URL', 'ftp://somesite.dev/post']) {
      const response = await request(app).get(`/api/hacker-news/resolve?url=${encodeURIComponent(url)}`);
      expect(response.status, url).toBe(400);
      expect(response.body).toEqual({ url: null });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

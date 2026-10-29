import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Express, Request as ExpressRequest, Response as ExpressResponse, NextFunction } from 'express';
import { parseFeedBundle, boundAndSort, discoverFeedLinks, PREVIEW_MAX_ARTICLES } from './publisher.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: ExpressRequest, _res: ExpressResponse, next: NextFunction) => {
    (req as ExpressRequest & { user: unknown }).user = { id: 1, username: 'tester', role: 'user', email: '', display_name: '', active: 1, auth_provider: 'local' };
    next();
  },
  requireAdmin: (_req: ExpressRequest, _res: ExpressResponse, next: NextFunction) => next(),
}));

// Mock upstream fetching so tests never touch network targets.
vi.mock('./proxy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proxy.js')>();
  return {
    ...actual,
    assertTargetSafe: vi.fn(async () => {}),
    fetchUpstream: vi.fn(),
    proxyRateLimiter: null,
  };
});
vi.mock('../cache.js', () => ({
  cacheEnabled: false,
  cacheGet: vi.fn(async () => null),
  cacheSet: vi.fn(async () => {}),
}));

import { fetchUpstream, assertTargetSafe } from './proxy.js';

type UpstreamMock = ReturnType<typeof vi.mocked<typeof fetchUpstream>>;

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>The New Stack</title><link>https://thenewstack.io/</link><description>Tech</description>
<item><title>First</title><link>https://thenewstack.io/a/</link><guid>g-a</guid><pubDate>Wed, 28 Oct 2026 10:00:00 GMT</pubDate><description>alpha</description></item>
<item><title>Second</title><link>https://thenewstack.io/b/</link><guid>g-b</guid><pubDate>Tue, 27 Oct 2026 09:00:00 GMT</pubDate><description>beta</description></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">
<title>Welt</title>
<link rel="alternate" href="https://www.welt.de/"/><link rel="self" href="https://www.welt.de/feeds"/>
<entry><title>Eins</title><link rel="alternate" href="https://www.welt.de/e"/><id>id-1</id><published>2026-10-28T10:00:00Z</published><summary>s1</summary></entry>
<entry><title>Zwei</title><link href="https://www.welt.de/z"/><id>id-2</id><updated>2026-10-27T09:00:00Z</updated><content>c2</content></entry>
</feed>`;

afterEach(() => {
  vi.restoreAllMocks();
  (fetchUpstream as unknown as UpstreamMock).mockReset();
});

function app(): Promise<Express> {
  return App();
}
async function App(): Promise<Express> {
  const { default: publisherRoutes } = await import('./publisher.js');
  const a = express();
  a.use('/api/publisher', publisherRoutes);
  return a as unknown as Express;
}

function resp(status: number, body: string, headers: Record<string, string>, location?: string): Response {
  const h = new Headers({ ...headers, ...(location ? { location } : {}) });
  return { status, headers: h, body: null, text: async () => body } as unknown as Response;
}

describe('parseFeedBundle', () => {
  it('parses an RSS channel with items', () => {
    const feed = parseFeedBundle('https://thenewstack.io/feed/', RSS);
    expect(feed).not.toBeNull();
    expect(feed!.kind).toBe('rss');
    expect(feed!.title).toBe('The New Stack');
    expect(feed!.siteUrl).toBe('https://thenewstack.io/');
    expect(feed!.items).toHaveLength(2);
    expect(feed!.items[0]).toEqual(expect.objectContaining({ id: 'g-a', url: 'https://thenewstack.io/a/', published: Date.parse('Wed, 28 Oct 2026 10:00:00 GMT') }));
  });

  it('parses Atom entries, preferring rel=alternate links', () => {
    const feed = parseFeedBundle('https://www.welt.de/feeds/index.rss', ATOM);
    expect(feed).not.toBeNull();
    expect(feed!.kind).toBe('atom');
    expect(feed!.items[0]).toEqual(expect.objectContaining({ id: 'id-1', url: 'https://www.welt.de/e' }));
    expect(feed!.items[1].published).toBe(Date.parse('2026-10-27T09:00:00Z'));
  });

  it('returns null on malformed XML', () => {
    expect(parseFeedBundle('https://x/', '<rss><channel>')).toBeNull();
  });

  it('returns null on a non-feed XML document', () => {
    expect(parseFeedBundle('https://x/', '<?xml version="1.0"?><html><body>hi</body></html>')).toBeNull();
  });
});

describe('boundAndSort', () => {
  const item = (id: string, published: number | null): Parameters<typeof boundAndSort>[0][number] =>
    ({ id, title: id, url: `https://x/${id}`, published, summary: '', author: '' });

  it('deduplicates by guid, keeping the first occurrence', () => {
    const out = boundAndSort([item('a', 5), item('a', 3), item('b', 4)]);
    expect(out.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('sorts newest first and pushes undated entries last', () => {
    const out = boundAndSort([item('undated', null), item('old', 1), item('new', 9), item('undated2', null)]);
    expect(out.map((i) => i.id)).toEqual(['new', 'old', 'undated', 'undated2']);
  });

  it('caps the result at 25 articles', () => {
    const items = Array.from({ length: 40 }, (_, i) => item(`i-${i}`, i));
    expect(boundAndSort(items)).toHaveLength(PREVIEW_MAX_ARTICLES);
  });
});

describe('discoverFeedLinks', () => {
  it('finds declared RSS/Atom alternates and resolves them', () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="/feed/" title="All">
      <link rel="alternate" type="application/atom+xml" href="https://example.org/atom.xml">
      <link rel="stylesheet" href="/style.css">
      <a rel="alternate" type="application/rss+xml" href="/wrong/">x</a>
    </head></html>`;
    const links = discoverFeedLinks(html, 'https://example.org/blog/');
    expect(links.map((l) => l.href)).toEqual(['https://example.org/feed/', 'https://example.org/atom.xml']);
    expect(links[0].title).toBe('All');
  });

  it('ignores unknown types and never invents feed URLs', () => {
    const links = discoverFeedLinks('<html><head><link rel="alternate" type="text/html" href="/rss"></head></html>', 'https://example.org/');
    expect(links).toEqual([]);
  });
});

describe('GET /api/publisher/preview', () => {
  it('serves parsed articles from a healthy RSS feed', async () => {
    (fetchUpstream as unknown as UpstreamMock).mockResolvedValueOnce(resp(200, RSS, { 'content-type': 'application/rss+xml' }));
    const r = await request(await app()).get('/api/publisher/preview').query({ feedUrl: 'https://thenewstack.io/feed/' });
    expect(r.status).toBe(200);
    expect(r.body.feed.title).toBe('The New Stack');
    expect(r.body.articles).toHaveLength(2);
    expect(assertTargetSafe).toHaveBeenCalledWith('https://thenewstack.io/feed/');
  });

  it('refuses a non-http(s) feed URL', async () => {
    const r = await request(await app()).get('/api/publisher/preview').query({ feedUrl: 'file:///etc/passwd' });
    expect(r.status).toBe(400);
  });

  it('follows at most 3 redirects, then fails', async () => {
    const mock = fetchUpstream as unknown as UpstreamMock;
    mock.mockImplementation(async (_url: string) => resp(302, '', {}, 'https://hop2.example.org/'));
    const r = await request(await app()).get('/api/publisher/preview').query({ feedUrl: 'https://hops.example.org/redirect-loop' });
    expect(r.status).toBe(502);
    expect(mock).toHaveBeenCalledTimes(4); // 3 hops + 1 exhausted
  });

  it('chases a redirect chain within the limit', async () => {
    const mock = fetchUpstream as unknown as UpstreamMock;
    const seen: string[] = [];
    mock.mockImplementation(async (url: string) => {
      seen.push(url);
      if (seen.length === 1) return resp(301, '', {}, 'https://hop2.example.org/feed');
      if (seen.length === 2) return resp(301, '', {}, 'https://www.canonical.example.org/feed');
      return resp(200, RSS, { 'content-type': 'application/rss+xml' });
    });
    const r = await request(await app()).get('/api/publisher/preview').query({ feedUrl: 'https://hop1.example.org/feed' });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(3);
  });

  it('rejects an HTML page served at a feed URL', async () => {
    (fetchUpstream as unknown as UpstreamMock).mockResolvedValueOnce(resp(200, '<html></html>', { 'content-type': 'text/html' }));
    const r = await request(await app()).get('/api/publisher/preview').query({ feedUrl: 'https://thenewstack.io/feed/' });
    expect(r.status).toBe(415);
  });

  it('rejects an oversized feed', async () => {
    // Streamed body: readBoundedText measures bytes, not the finished string.
    // 7 MB exceeds the 5 MB parse bound (a real substack full-content feed is
    // ~2.2 MB and must NOT be rejected).
    const chunks = Array.from({ length: 7 }, () => new Uint8Array(1_000_000).fill(0x78)); // 'x'
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk); else controller.close();
      },
    });
    (fetchUpstream as unknown as UpstreamMock).mockResolvedValueOnce({
      status: 200,
      headers: new Headers({ 'content-type': 'application/rss+xml' }),
      body,
    } as unknown as Response);
    const r = await request(await app()).get('/api/publisher/preview').query({ feedUrl: 'https://thenewstack.io/feed/' });
    expect(r.status).toBe(502);
  });
});

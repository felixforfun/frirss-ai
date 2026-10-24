import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const { preference, fetchMock, assertSafeMock, dbRows } = vi.hoisted(() => ({
  preference: { value: JSON.stringify(['wsj.com', 'ft.com']) as string | undefined },
  fetchMock: vi.fn(),
  assertSafeMock: vi.fn().mockResolvedValue(undefined),
  dbRows: [] as Array<{ id: number; at: string; requested_url: string; final_status: string; trace: string }>,
}));

vi.mock('../db.js', () => ({
  default: {
    exec: () => { /* diagnostics table not created under the test mock */ },
    prepare: (sql: string) => {
      if (sql.includes('SELECT value FROM preferences')) {
        return { get: () => preference.value ? { value: preference.value } : undefined };
      }
      if (sql.includes('INSERT INTO archive_resolve_debug')) {
        return {
          run: (url: string, status: string, trace: string) => {
            dbRows.push({ id: dbRows.length + 1, at: 'test', requested_url: url, final_status: status, trace });
            return { changes: 1 };
          },
        };
      }
      if (sql.includes('SELECT id, at, requested_url')) {
        return { all: () => [...dbRows].reverse() };
      }
      // Unrecognised test SQL: behave like an empty result.
      return { run: () => ({ changes: 0 }), get: () => undefined, all: () => [] };
    },
  },
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    (req as express.Request & { user: { id: number } }).user = { id: 1 } as never;
    next();
  },
}));
vi.mock('../routes/proxy.js', () => ({
  assertTargetSafe: assertSafeMock,
  fetchUpstream: fetchMock,
  proxyRateLimiter: null,
}));
vi.mock('../cache.js', () => ({
  cacheEnabled: false,
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheKey: (_userId: number, key: string) => key,
}));

const { default: archiveRoutes, parseTimeMap, looksLikeChallengePage } = await import('../routes/archive.js');
const app = express();
app.use('/api/archive', archiveRoutes);

const timemap = (url: string) => [
  `<${url}>; rel="original"`,
  `<http://archive.md/20261016021348/${url}>; rel="first memento"; datetime="Fri, 16 Oct 2026 02:13:48 GMT"`,
  `<http://archive.md/20261017140859/${url}>; rel="last memento"; datetime="Sat, 17 Oct 2026 14:08:59 GMT"`,
].join('\n');

function response(body: string, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': contentType } });
}

describe('Archive.is snapshot resolver', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    assertSafeMock.mockClear();
    preference.value = JSON.stringify(['wsj.com', 'ft.com']);
  });

  it('archives a WELT article only when its matching NewsArticle metadata marks it premium', async () => {
    const original = 'https://www.welt.de/politik/deutschland/plus123/test-article.html';
    const metadata = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      url: original,
      isAccessibleForFree: false,
    });
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target === original) {
        return response(`<html><head><script type="application/ld+json">${metadata}</script></head><body>Article</body></html>`, 'text/html');
      }
      if (target.includes('/timemap/')) return response(timemap(original), 'application/link-format');
      if (target.includes('/20261017140859/') || target.includes('/20261016021348/')) {
        return response('<!doctype html><html><head><title>A real archived article</title></head><body><article><p>This is a real article body, not a challenge page.</p></article></body></html>', 'text/html');
      }
      throw new Error(`Unexpected archive fetch: ${target}`);
    });

    const result = await request(app).get('/api/archive/resolve').query({ url: original });

    expect(result.body.status).toBe('ok');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/timemap/'))).toBe(true);
  });

  it('detects premium WELT metadata in the bounded prefix of a large HTML page', async () => {
    const original = 'https://www.welt.de/debatte/plus123/large-premium-article.html';
    const metadata = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      url: original,
      isAccessibleForFree: false,
    });
    const largeHtml = `<html><head><script type="application/ld+json">${metadata}</script></head><body>${'x'.repeat(1_600_000)}</body></html>`;
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target === original) return response(largeHtml, 'text/html');
      if (target.includes('/timemap/')) return response(timemap(original), 'application/link-format');
      if (target.includes('/20261017140859/') || target.includes('/20261016021348/')) {
        return response('<!doctype html><html><head><title>A real archived article</title></head><body><article><p>This is a real archived article body.</p></article></body></html>', 'text/html');
      }
      throw new Error(`Unexpected archive fetch: ${target}`);
    });

    const result = await request(app).get('/api/archive/resolve').query({ url: original });

    expect(result.body.status).toBe('ok');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/timemap/'))).toBe(true);
  });

  it('archives a WELT+ opinion article whose metadata uses the OpinionNewsArticle subtype', async () => {
    // Real markup shape from welt.de: debatte pieces declare OpinionNewsArticle
    // (a schema.org NewsArticle subtype) instead of plain NewsArticle.
    const original = 'https://www.welt.de/debatte/plus6ad9f34ad6da4afc14800502/krawalle-1968-und-2026-die-rueckkehr-der-stadtguerilla.html';
    const metadata = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'OpinionNewsArticle',
      url: original,
      isAccessibleForFree: false,
    });
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target === original) {
        return response(`<html><head><script type="application/ld+json">${metadata}</script></head><body>Article</body></html>`, 'text/html');
      }
      if (target.includes('/timemap/')) return response(timemap(original), 'application/link-format');
      if (target.includes('/20261017140859/') || target.includes('/20261016021348/')) {
        return response('<!doctype html><html><head><title>A real archived article</title></head><body><article><p>This is a real article body, not a challenge page.</p></article></body></html>', 'text/html');
      }
      throw new Error(`Unexpected archive fetch: ${target}`);
    });

    const result = await request(app).get('/api/archive/resolve').query({ url: original });

    expect(result.body.status).toBe('ok');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/timemap/'))).toBe(true);
  });

  it('does not archive a free WELT article even when the subtype family is OpinionNewsArticle', async () => {
    const original = 'https://www.welt.de/debatte/article123/free-opinion-article.html';
    const metadata = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'OpinionNewsArticle',
      url: original,
      isAccessibleForFree: true,
    });
    fetchMock.mockResolvedValue(response(
      `<html><head><script type="application/ld+json">${metadata}</script></head><body>Article</body></html>`,
      'text/html',
    ));

    const result = await request(app).get('/api/archive/resolve').query({ url: original });

    expect(result.body).toEqual({ status: 'not_allowed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed for WELT when the metadata type is not a NewsArticle family member', async () => {
    const original = 'https://www.welt.de/kultur/article123/untyped-marker-article.html';
    const metadata = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'CreativeWork',
      url: original,
      isAccessibleForFree: false,
    });
    fetchMock.mockResolvedValue(response(
      `<html><head><script type="application/ld+json">${metadata}</script></head><body>Article</body></html>`,
      'text/html',
    ));

    const result = await request(app).get('/api/archive/resolve').query({ url: original });

    expect(result.body).toEqual({ status: 'not_allowed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not archive a free WELT article even when unrelated premium teasers may exist on the page', async () => {
    const original = 'https://www.welt.de/kultur/article123/free-article.html';
    const metadata = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      url: original,
      isAccessibleForFree: true,
    });
    fetchMock.mockResolvedValue(response(
      `<html><head><script type="application/ld+json">${metadata}</script></head><body><span class="c-teaser__badge is-premium">Weltplus Artikel</span></body></html>`,
      'text/html',
    ));

    const result = await request(app).get('/api/archive/resolve').query({ url: original });

    expect(result.body).toEqual({ status: 'not_allowed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/timemap/'))).toBe(false);
  });

  it('fails closed for WELT when article-level access metadata is missing', async () => {
    const original = 'https://www.welt.de/kultur/article123/unknown-article.html';
    // Metadata for a different article URL must not make this one premium.
    const other = 'https://www.welt.de/other-article';
    const metadata = JSON.stringify({
      '@type': 'NewsArticle',
      url: other,
      isAccessibleForFree: false,
    });
    fetchMock.mockResolvedValue(response(
      `<html><head><script type="application/ld+json">${metadata}</script></head><body>Article</body></html>`,
      'text/html',
    ));

    const result = await request(app).get('/api/archive/resolve').query({ url: original });

    expect(result.body).toEqual({ status: 'not_allowed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips a latest challenge snapshot and selects the newest usable older capture', async () => {
    const original = 'https://www.wsj.com/world/article-a';
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.includes('/timemap/')) return response(timemap(original), 'application/link-format');
      if (target.includes('/20261017140859/')) {
        return response('<!doctype html><html><head><title>wsj.com</title></head><body>Please enable JS and disable any ad blocker</body></html>', 'text/html');
      }
      if (target.includes('/20261016021348/')) {
        return response('<!doctype html><html><head><title>The Defector: A Russian story</title></head><body><article><p>This archived article contains readable body text beyond the basic challenge-page threshold.</p><p>Another paragraph provides enough visible text to distinguish this from an error page.</p></article></body></html>', 'text/html');
      }
      throw new Error(`Unexpected archive fetch: ${target}`);
    });

    const result = await request(app).get('/api/archive/resolve').query({ url: original });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      status: 'ok',
      url: 'https://archive.is/20261016021348/https://www.wsj.com/world/article-a',
      timestamp: '20261016021348',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('treats an HTML spinner as a soft block even when the status is 200', async () => {
    fetchMock.mockResolvedValue(response('<html><body>Loading...<img src="spinner.gif"></body></html>', 'text/html'));
    const result = await request(app).get('/api/archive/resolve').query({ url: 'https://www.ft.com/content/article-spinner' });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'soft_block' });
  });

  it('rejects hosts outside the saved allowlist', async () => {
    const result = await request(app).get('/api/archive/resolve').query({ url: 'https://notft.com/article' });
    expect(result.body).toEqual({ status: 'not_allowed' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('records the resolve decision path for diagnostics', async () => {
    const original = 'https://www.ft.com/content/diagnostic-trace';
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      if (target.includes('/timemap/')) return response(timemap(original), 'application/link-format');
      if (target.includes('/20261017140859/') || target.includes('/20261016021348/')) {
        return response('<!doctype html><html><head><title>A real archived article</title></head><body><article><p>A real archived article body for diagnostics.</p></article></body></html>', 'text/html');
      }
      throw new Error(`Unexpected archive fetch: ${target}`);
    });

    const resolved = await request(app).get('/api/archive/resolve').query({ url: original });
    expect(resolved.body.status).toBe('ok');

    const debug = await request(app).get('/api/archive/debug');
    expect(debug.status).toBe(200);
    const row = (debug.body.rows || []).find((entry: { requested_url: string }) => entry.requested_url === original);
    expect(row).toBeTruthy();
    expect(row.final_status).toBe('ok');
    expect(row.trace.timemap.count).toBeGreaterThanOrEqual(1);
    expect(row.trace.snapshots.some((s: { usable: boolean }) => s.usable)).toBe(true);
    expect(row.trace.winner).toContain(original);
  });

  it('fails the timemap over to another mirror when archive.is is unreachable', async () => {
    const original = 'https://www.wsj.com/world/mirror-failover-article';
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      // archive.is hangs on some networks: every request to it aborts. This
      // check must come before the /timemap/ match so the timemap request to
      // archive.is aborts too.
      if (target.startsWith('https://archive.is/')) throw new Error('This operation was aborted');
      if (target.includes('/timemap/')) return response(timemap(original), 'application/link-format');
      if (target.includes('/20261017140859/') || target.includes('/20261016021348/')) {
        return response('<!doctype html><html><head><title>A real archived article</title></head><body><article><p>A real article body served from the reachable mirror.</p></article></body></html>', 'text/html');
      }
      throw new Error(`Unexpected archive fetch: ${target}`);
    });

    const result = await request(app).get('/api/archive/resolve').query({ url: original });

    expect(result.body.status).toBe('ok');
    // The winning snapshot is still reported under the canonical archive.is
    // host because all mirrors serve the same backend.
    expect(result.body.url).toBe(`https://archive.is/20261017140859/${original}`);
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('https://archive.ph/timemap/'))).toBe(true);
  });

  it('retries the timemap without share-tracking query parameters after a 404', async () => {
    const original = 'https://www.wsj.com/world/share-link-article?st=abc&reflink=share';
    const bare = 'https://www.wsj.com/world/share-link-article';
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      // Share links carry tracking params (?st=…&reflink=…) that the archive
      // does not index: the param'd timemap 404s while the bare URL resolves.
      if (target.startsWith('https://archive.is/timemap/') && target.includes('?')) {
        return response('TimeMap does not exists. The archive has no Mementos for the requested URI', 'text/plain;charset=utf-8', 404);
      }
      if (target.includes('/timemap/')) return response(timemap(bare), 'application/link-format');
      if (target.includes('/20261017140859/') || target.includes('/20261016021348/')) {
        return response('<!doctype html><html><head><title>A real archived article</title></head><body><article><p>A real article body for the bare-URL snapshot.</p></article></body></html>', 'text/html');
      }
      throw new Error(`Unexpected archive fetch: ${target}`);
    });

    const result = await request(app).get('/api/archive/resolve').query({ url: original });

    expect(result.body.status).toBe('ok');
    expect(result.body.url).toBe(`https://archive.is/20261017140859/${bare}`);
    const row = dbRows.find((entry) => entry.requested_url === original);
    expect(row?.final_status).toBe('ok');
    expect(JSON.parse(row?.trace || '{}').timemapSource).toBe('bare');
  });

  it('probes the snapshot on another mirror when the canonical host is unreachable', async () => {
    const original = 'https://www.ft.com/content/probe-failover-article';
    fetchMock.mockImplementation(async (url: string) => {
      const target = String(url);
      // The timemap is reachable on archive.is, but fetching the snapshot from
      // it aborts; the probe must move on to the next mirror.
      if (target.includes('/timemap/')) return response(timemap(original), 'application/link-format');
      if (target.startsWith('https://archive.is/')) throw new Error('This operation was aborted');
      if (target.includes('/20261017140859/') || target.includes('/20261016021348/')) {
        return response('<!doctype html><html><head><title>A real archived article</title></head><body><article><p>A real article body probed on the reachable mirror.</p></article></body></html>', 'text/html');
      }
      throw new Error(`Unexpected archive fetch: ${target}`);
    });

    const result = await request(app).get('/api/archive/resolve').query({ url: original });

    expect(result.body.status).toBe('ok');
    expect(result.body.url).toBe(`https://archive.is/20261017140859/${original}`);
    expect(result.body.timestamp).toBe('20261017140859');
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith('https://archive.ph/20261017140859/'))).toBe(true);
  });

  it('parses relation tokens and orders multiple mementos newest first', () => {
    const original = 'https://www.wsj.com/world/article-a';
    const body = [
      `<${original}>; rel="original"`,
      `<http://archive.md/20261016021348/${original}>; rel="first memento"; datetime="Fri, 16 Oct 2026 02:13:48 GMT"`,
      `<http://archive.li/20261017140859/${original}>; rel="last memento alternate"; datetime="Sat, 17 Oct 2026 14:08:59 GMT"`,
    ].join('\n');
    expect(parseTimeMap(body).map((item) => item.timestamp)).toEqual(['20261017140859', '20261016021348']);
    expect(parseTimeMap(body)[0].url).toBe('https://archive.is/20261017140859/https://www.wsj.com/world/article-a');
  });

  it('does not reject a snapshot merely because HTML contains a captcha attribute', () => {
    const html = '<html><head><title>A genuine article headline</title></head><body><article data-captcha-site-key="abc"><p>A short but real article excerpt.</p></article></body></html>';
    expect(looksLikeChallengePage(html, 'www.wsj.com')).toBe(false);
  });
});

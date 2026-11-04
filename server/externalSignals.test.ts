import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import db from './db.js';
import {
  canonicalUrl,
  cacheKey,
  ttlForSignal,
  readSignalCache,
  writeSignalCache,
  recordSignalFailure,
  writeSnapshot,
  readLatestSnapshot,
  Breaker,
  SignalHttpError,
  SignalBodyError,
  fetchProviderJson,
  tripBreakerFor,
  isLikelyGermanTitle,
  gdeltLanguageGuardEnabled,
  githubLookup,
  gdeltLookup,
  hackerNewsLookup,
  refreshLobstersSnapshot,
  lobstersLookup,
  ProviderScheduler,
  BudgetExceededError,
  CancelledLookupError,
  runLookup,
  schedulers,
  type ExternalArticleInput,
  type SignalValue,
} from './externalSignals.js';

function wipe() {
  db.prepare('DELETE FROM interesting_external_signal_cache').run();
  db.prepare('DELETE FROM signal_failures').run();
  db.prepare('DELETE FROM signal_snapshots').run();
}

const article = (overrides: Partial<ExternalArticleInput> = {}): ExternalArticleInput => ({
  url: 'https://example.com/story',
  title: 'A new release',
  summary: 'Something happened.',
  content: '',
  ...overrides,
});

// ── fetch mocking helpers ───────────────────────────────────────────────

type FetchCall = { url: string; init?: RequestInit };
let fetchCalls: FetchCall[] = [];

function stubFetch(impl: (call: FetchCall) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const call = { url, init };
    fetchCalls.push(call);
    return Promise.resolve(impl(call));
  });
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const status = init.status ?? 200;
  const headers = new Map(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  wipe();
  fetchCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── canonicalUrl / cacheKey ─────────────────────────────────────────────

describe('canonicalUrl', () => {
  it('strips tracking parameters, hash, and trailing slash', () => {
    expect(canonicalUrl('https://example.com/a/?utm_source=x&fbclid=1&id=2#frag'))
      .toBe('https://example.com/a?id=2');
  });

  it('upgrades http to https, lowercases host and removes www.', () => {
    expect(canonicalUrl('http://WWW.Example.com/Page')).toBe('https://example.com/Page');
  });

  it('keeps the root path as a slash', () => {
    expect(canonicalUrl('https://example.com/')).toBe('https://example.com/');
  });

  it('returns the trimmed input for unparseable urls', () => {
    expect(canonicalUrl('  not a url  ')).toBe('not a url');
  });
});

describe('cacheKey', () => {
  it('is stable across url variants of the same article', () => {
    expect(cacheKey('hackerNews', 'https://example.com/a?utm_source=x'))
      .toBe(cacheKey('hackerNews', 'http://www.example.com/a/'));
  });

  it('differs per source for the same url', () => {
    expect(cacheKey('github', 'https://example.com/a')).not.toBe(cacheKey('gdelt', 'https://example.com/a'));
  });
});

// ── TTL policy ──────────────────────────────────────────────────────────

describe('ttlForSignal', () => {
  it('uses per-source TTLs for measured values', () => {
    expect(ttlForSignal('gdelt', { state: 'measured', value: 1 }, undefined)).toBe(24 * 3600_000);
    expect(ttlForSignal('github', { state: 'measured', value: 1 }, undefined)).toBe(12 * 3600_000);
    expect(ttlForSignal('hackerNews', { state: 'measured', value: 1 }, undefined)).toBe(6 * 3600_000);
    expect(ttlForSignal('wikipedia', { state: 'measured', value: 1 }, undefined)).toBe(24 * 3600_000);
  });

  it('caches fresh-article misses short and old-article misses long', () => {
    const none: SignalValue = { state: 'none' };
    const fresh = Date.now() - 3600_000; // 1 h old
    const old = Date.now() - 48 * 3600_000; // 2 days old
    expect(ttlForSignal('gdelt', none, fresh)).toBe(2 * 3600_000);
    expect(ttlForSignal('gdelt', none, old)).toBe(24 * 3600_000);
    // Unknown age is treated as old.
    expect(ttlForSignal('gdelt', none, undefined)).toBe(24 * 3600_000);
  });

  it('caches not-applicable for a day and never caches unavailable', () => {
    expect(ttlForSignal('github', { state: 'not-applicable' }, undefined)).toBe(24 * 3600_000);
    expect(ttlForSignal('github', { state: 'unavailable' }, undefined)).toBe(0);
  });
});

// ── Signal cache persistence ────────────────────────────────────────────

describe('readSignalCache / writeSignalCache', () => {
  it('misses on an empty cache', () => {
    expect(readSignalCache('github', 'nope')).toEqual({ hit: false, signal: null });
  });

  it('round-trips a measured value', () => {
    const key = cacheKey('github', 'https://example.com/repo');
    writeSignalCache(key, { state: 'measured', value: 0.5 });
    const result = readSignalCache('github', key);
    expect(result.hit).toBe(true);
    expect(result.signal).toEqual({ state: 'measured', value: 0.5 });
  });

  it('round-trips not-applicable and none', () => {
    const key = cacheKey('github', 'https://example.com/repo');
    writeSignalCache(key, { state: 'not-applicable' });
    expect(readSignalCache('github', key).signal).toEqual({ state: 'not-applicable' });
    writeSignalCache(key, { state: 'none' });
    expect(readSignalCache('github', key).signal).toEqual({ state: 'none' });
  });

  it('maps legacy v1 rows: bare values become measured, nulls become unavailable', () => {
    const key = cacheKey('github', 'https://example.com/legacy');
    db.prepare('INSERT INTO interesting_external_signal_cache (cache_key, value_json, checked_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify({ value: 0.42 }), Date.now());
    expect(readSignalCache('github', key).signal).toEqual({ state: 'measured', value: 0.42 });

    // A legacy null value maps to state 'unavailable', which carries a zero
    // TTL — so the row is present but immediately expired.
    db.prepare('UPDATE interesting_external_signal_cache SET value_json = ? WHERE cache_key = ?')
      .run(JSON.stringify({ value: null }), key);
    expect(readSignalCache('github', key)).toEqual({ hit: true, signal: null });
  });

  it('treats an expired entry as a hit with no signal', () => {
    const key = cacheKey('github', 'https://example.com/expired');
    writeSignalCache(key, { state: 'unavailable' }); // ttl 0
    const result = readSignalCache('github', key);
    expect(result.hit).toBe(true);
    expect(result.signal).toBeNull();
  });

  it('ignores corrupt json', () => {
    const key = cacheKey('github', 'https://example.com/corrupt');
    db.prepare('INSERT INTO interesting_external_signal_cache (cache_key, value_json, checked_at) VALUES (?, ?, ?)')
      .run(key, '{not json', Date.now());
    expect(readSignalCache('github', key)).toEqual({ hit: false, signal: null });
  });
});

// ── Failure accounting + snapshots ──────────────────────────────────────

describe('recordSignalFailure', () => {
  it('upserts one row per (provider, key) keeping the latest', () => {
    const key = cacheKey('gdelt', 'https://example.com/a');
    recordSignalFailure('gdelt', key, 'HTTP 429', Date.now() + 60_000);
    recordSignalFailure('gdelt', key, 'HTTP 503', Date.now() + 120_000);
    const rows = db.prepare('SELECT * FROM signal_failures WHERE provider = ? AND cache_key = ?').all('gdelt', key) as Array<{ reason: string; backoff_until: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('HTTP 503');
  });
});

describe('writeSnapshot / readLatestSnapshot', () => {
  it('returns null when nothing was stored', () => {
    expect(readLatestSnapshot('lobsters', 'frontpage')).toBeNull();
  });

  it('returns the latest payload', () => {
    writeSnapshot('lobsters', 'frontpage', [{ url: 'https://lobste.rs/a', score: 1 }], 60_000);
    const snap = readLatestSnapshot<{ url: string; score: number }[]>('lobsters', 'frontpage');
    expect(snap).not.toBeNull();
    expect(snap!.payload[0].score).toBe(1);
  });

  it('prefers the newest of several writes', () => {
    writeSnapshot('lobsters', 'frontpage', { v: 1 }, 60_000);
    writeSnapshot('lobsters', 'frontpage', { v: 2 }, 60_000);
    expect(readLatestSnapshot<{ v: number }>('lobsters', 'frontpage')!.payload.v).toBe(2);
  });
});

// ── Circuit breaker ─────────────────────────────────────────────────────

describe('Breaker', () => {
  it('starts closed', () => {
    const breaker = new Breaker();
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.remainingMs()).toBe(0);
    expect(breaker.until()).toBe(0);
  });

  it('opens for at least the minimum backoff when tripped', () => {
    const breaker = new Breaker();
    const now = 1_000_000;
    breaker.trip(now);
    expect(breaker.isOpen(now)).toBe(true);
    expect(breaker.remainingMs(now)).toBeGreaterThanOrEqual(60_000);
  });

  it('doubles backoff on consecutive trips and caps at 30 minutes', () => {
    const breaker = new Breaker();
    const now = 1_000_000;
    breaker.trip(now);
    const first = breaker.remainingMs(now);
    // Simulate a trip right after the previous one expired.
    const next = now + first;
    breaker.trip(next);
    const second = breaker.remainingMs(next);
    expect(second).toBe(first * 2);

    for (let i = 0; i < 10; i++) breaker.trip(now);
    expect(breaker.remainingMs(now)).toBeLessThanOrEqual(30 * 60_000);
  });

  it('honors a longer retryAfterMs hint', () => {
    const breaker = new Breaker();
    const now = 1_000_000;
    breaker.trip(now, 180_000);
    expect(breaker.remainingMs(now)).toBe(180_000);
  });

  it('never shortens an already-open window', () => {
    const breaker = new Breaker();
    const now = 1_000_000;
    breaker.trip(now, 300_000);
    breaker.trip(now, 60_000);
    expect(breaker.remainingMs(now)).toBe(300_000);
  });

  it('resets on success and reports until() only while open', () => {
    const breaker = new Breaker();
    const now = 1_000_000;
    breaker.trip(now);
    const openUntil = breaker.until(now);
    expect(openUntil).toBeGreaterThan(now);
    breaker.recordSuccess();
    expect(breaker.isOpen(now)).toBe(false);
    expect(breaker.until(now)).toBe(0);
  });
});

describe('tripBreakerFor', () => {
  it('trips on 429 and honors retry-after', () => {
    const breaker = new Breaker();
    const now = 1_000_000;
    tripBreakerFor(breaker, new SignalHttpError(429, 'rate limited', 90_000), now);
    expect(breaker.isOpen(now)).toBe(true);
    expect(breaker.remainingMs(now)).toBe(90_000);
  });

  it('trips on 403, using the rate-limit reset header when present', () => {
    const breaker = new Breaker();
    const now = 1_000_000; // epoch seconds; reset = 1010 → 10 s away
    tripBreakerFor(breaker, new SignalHttpError(403, 'forbidden', undefined, 1010), now);
    expect(breaker.isOpen(now)).toBe(true);
    // The breaker floors any hint at its 60 s minimum backoff.
    expect(breaker.remainingMs(now)).toBe(60_000);
  });

  it('does not trip on transient http statuses', () => {
    const breaker = new Breaker();
    tripBreakerFor(breaker, new SignalHttpError(500, 'boom'));
    tripBreakerFor(breaker, new SignalHttpError(404, 'missing'));
    expect(breaker.isOpen()).toBe(false);
  });

  it('trips on malformed bodies but not on plain network errors', () => {
    const trip = new Breaker();
    tripBreakerFor(trip, new SignalBodyError('non-json'));
    expect(trip.isOpen()).toBe(true);

    const net = new Breaker();
    tripBreakerFor(net, new Error('socket hang up'));
    expect(net.isOpen()).toBe(false);
  });
});

// ── fetchProviderJson ───────────────────────────────────────────────────

describe('fetchProviderJson', () => {
  it('parses a json body and sends the provider user agent', async () => {
    stubFetch(() => jsonResponse({ hello: 'world' }));
    const data = await fetchProviderJson<{ hello: string }>('https://api.example.com/x');
    expect(data.hello).toBe('world');
    expect(fetchCalls[0].init?.headers).toMatchObject({ 'User-Agent': 'FriRSS-Interesting/1.0' });
  });

  it('throws SignalHttpError with parsed retry-after on http failure', async () => {
    stubFetch(() => jsonResponse({}, { status: 429, headers: { 'retry-after': '12' } }));
    const error = await fetchProviderJson('https://api.example.com/x').then(
      () => { throw new Error('expected rejection'); },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SignalHttpError);
    expect((error as SignalHttpError).status).toBe(429);
    expect((error as SignalHttpError).retryAfterMs).toBe(12_000);
  });

  it('throws SignalBodyError on non-json bodies', async () => {
    stubFetch(() => textResponse('<html>maintenance wall</html>'));
    await expect(fetchProviderJson('https://api.example.com/x')).rejects.toBeInstanceOf(SignalBodyError);
  });

  it('merges caller headers (e.g. github auth)', async () => {
    stubFetch(() => jsonResponse({}));
    await fetchProviderJson('https://api.github.com/repos/a/b', { headers: { Authorization: 'Bearer x' } });
    expect(fetchCalls[0].init?.headers).toMatchObject({
      'User-Agent': 'FriRSS-Interesting/1.0',
      Authorization: 'Bearer x',
    });
  });
});

// ── Language guard ──────────────────────────────────────────────────────

describe('isLikelyGermanTitle', () => {
  it('detects german titles by two markers and no english ones', () => {
    expect(isLikelyGermanTitle('Das ist ein neuer Rekord')).toBe(true);
    expect(isLikelyGermanTitle('Die Regierung wurde nicht informiert')).toBe(true);
  });

  it('does not flag english or mixed titles', () => {
    expect(isLikelyGermanTitle('The new release is out')).toBe(false);
    expect(isLikelyGermanTitle('Der Test und the results')).toBe(false);
    expect(isLikelyGermanTitle('Postgres 17 ist da')).toBe(false); // only one german marker
  });
});

describe('gdeltLanguageGuardEnabled', () => {
  const original = process.env.GDELT_LANGUAGE_GUARD;
  afterEach(() => {
    if (original === undefined) delete process.env.GDELT_LANGUAGE_GUARD;
    else process.env.GDELT_LANGUAGE_GUARD = original;
  });

  it('is on by default and can be disabled', () => {
    delete process.env.GDELT_LANGUAGE_GUARD;
    expect(gdeltLanguageGuardEnabled()).toBe(true);
    process.env.GDELT_LANGUAGE_GUARD = 'off';
    expect(gdeltLanguageGuardEnabled()).toBe(false);
  });
});

// ── githubLookup ────────────────────────────────────────────────────────

describe('githubLookup', () => {
  it('returns not-applicable when no repository link exists, without fetching', async () => {
    stubFetch(() => jsonResponse({}));
    const result = await githubLookup(article({ title: 'A story about databases' }), new Breaker());
    expect(result).toEqual({ state: 'not-applicable' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('extracts owner/repo from the article text and measures popularity/activity', async () => {
    stubFetch(() => jsonResponse({ stargazers_count: 10_000, pushed_at: new Date().toISOString(), archived: false }));
    const result = await githubLookup(
      article({ url: 'https://example.com/post', content: 'See https://github.com/psf/requests for details.' }),
      new Breaker(),
    );
    expect(result.state).toBe('measured');
    expect(result.value).toBeGreaterThan(0);
    expect(result.value).toBeLessThanOrEqual(1);
    expect(fetchCalls[0].url).toContain('https://api.github.com/repos/psf/requests');
  });

  it('ignores non-repository github links (features, orgs, settings)', async () => {
    stubFetch(() => jsonResponse({}));
    const result = await githubLookup(
      article({ content: 'Learn about https://github.com/features/security today.' }),
      new Breaker(),
    );
    expect(result).toEqual({ state: 'not-applicable' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('caps the popularity component and treats archived repos as inactive', async () => {
    stubFetch(() => jsonResponse({ stargazers_count: 500_000, pushed_at: '2020-01-01T00:00:00Z', archived: true }));
    const result = await githubLookup(
      article({ content: 'https://github.com/a/b' }),
      new Breaker(),
    );
    // popularity saturates at 1, activity is 0 for archived → value = 0.65
    expect(result.state).toBe('measured');
    expect(result.value).toBeCloseTo(0.65, 5);
  });

  it('propagates provider failures (tripping is the caller\'s job)', async () => {
    stubFetch(() => jsonResponse({}, { status: 403, headers: { 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 60) } }));
    const breaker = new Breaker();
    await expect(githubLookup(article({ content: 'https://github.com/a/b' }), breaker))
      .rejects.toBeInstanceOf(SignalHttpError);
    // The lookup itself never mutates the breaker; runLookup does the tripping.
    expect(breaker.isOpen()).toBe(false);
  });
});

// ── gdeltLookup ─────────────────────────────────────────────────────────

describe('gdeltLookup', () => {
  it('returns unavailable for likely german titles without fetching', async () => {
    stubFetch(() => jsonResponse({}));
    const result = await gdeltLookup(article({ title: 'Die Regierung hat nicht gehandelt' }), new Breaker());
    expect(result.state).toBe('unavailable');
    expect(fetchCalls).toHaveLength(0);
  });

  it('returns a real zero when the title has no meaningful query terms', async () => {
    stubFetch(() => jsonResponse({}));
    const result = await gdeltLookup(article({ title: 'The and for with' }), new Breaker());
    expect(result).toEqual({ state: 'measured', value: 0 });
    expect(fetchCalls).toHaveLength(0);
  });

  it('measures breadth and volume from returned articles', async () => {
    stubFetch(() => jsonResponse({
      articles: Array.from({ length: 20 }, (_, i) => ({ url: `https://site${i}.com/x`, domain: `site${i}.com` })),
    }));
    const result = await gdeltLookup(article({ title: 'Postgres 17 released with major performance gains' }), new Breaker());
    expect(result.state).toBe('measured');
    expect(result.value).toBeGreaterThan(0);
    expect(result.value).toBeLessThanOrEqual(1);
    const url = new URL(fetchCalls[0].url);
    expect(url.searchParams.get('mode')).toBe('artlist');
    expect(url.searchParams.get('maxrecords')).toBe('50');
  });
});

// ── hackerNewsLookup ────────────────────────────────────────────────────

describe('hackerNewsLookup', () => {
  it('returns none when the url is not on HN', async () => {
    stubFetch(() => jsonResponse({ hits: [{ url: 'https://other.com/x', points: 100, num_comments: 10 }] }));
    const result = await hackerNewsLookup(article(), new Breaker());
    expect(result).toEqual({ state: 'none' });
  });

  it('measures engagement for a matching story, discounting by age', async () => {
    const recent = Math.floor(Date.now() / 1000) - 3600;
    stubFetch(() => jsonResponse({ hits: [{ url: 'https://example.com/story', points: 400, num_comments: 200, created_at_i: recent }] }));
    const result = await hackerNewsLookup(article(), new Breaker());
    expect(result.state).toBe('measured');
    expect(result.value).toBeGreaterThan(0);
    expect(result.value).toBeLessThanOrEqual(1);
  });

  it('normalizes url variants when matching', async () => {
    stubFetch(() => jsonResponse({ hits: [{ url: 'http://www.example.com/story?utm_source=hn', points: 10, num_comments: 0 }] }));
    const result = await hackerNewsLookup(article({ url: 'https://example.com/story' }), new Breaker());
    expect(result.state).toBe('measured');
  });
});

// ── Lobsters snapshot ───────────────────────────────────────────────────

describe('lobsters snapshot', () => {
  it('lobstersLookup is unavailable before any snapshot exists', () => {
    expect(lobstersLookup(article())).toEqual({ state: 'unavailable' });
  });

  it('refreshLobstersSnapshot merges hottest and newest and stores one snapshot', async () => {
    const hottest = [{ url: 'https://a.com/1', score: 20, comments_count: 5, created_at: new Date().toISOString() }];
    const newest = [{ url: 'https://b.com/2', score: 1, comments_count: 0, created_at: new Date().toISOString() },
      { url: 'https://a.com/1', score: 20, comments_count: 5, created_at: new Date().toISOString() }];
    let call = 0;
    stubFetch(() => jsonResponse(call++ === 0 ? hottest : newest));
    const { stories, status } = await refreshLobstersSnapshot(new Breaker());
    expect(status).toBe('ok');
    expect(stories).toHaveLength(2); // duplicate dropped
    expect(fetchCalls[0].url).toContain('hottest.json');
    expect(fetchCalls[1].url).toContain('newest.json');
    const stored = readLatestSnapshot<typeof stories>('lobsters', 'frontpage');
    expect(stored!.payload).toHaveLength(2);
  });

  it('lobstersLookup measures engagement for a story on the front page', async () => {
    writeSnapshot('lobsters', 'frontpage', [{ url: 'https://example.com/story', score: 100, comments_count: 50, created_at: new Date().toISOString() }], 60_000);
    const result = lobstersLookup(article());
    expect(result.state).toBe('measured');
    expect(result.value).toBeGreaterThan(0);
  });

  it('lobstersLookup returns none when the article is not on the front page', () => {
    writeSnapshot('lobsters', 'frontpage', [{ url: 'https://other.com/x', score: 5, created_at: new Date().toISOString() }], 60_000);
    expect(lobstersLookup(article())).toEqual({ state: 'none' });
  });
});

// ── ProviderScheduler ───────────────────────────────────────────────────

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('ProviderScheduler', () => {
  it('runs a scheduled lookup and resolves with its signal', async () => {
    const scheduler = new ProviderScheduler('github', { concurrency: 2, minSpacingMs: 0, jitterMs: 0 });
    const promise = scheduler.schedule('k1', 0, async () => ({ state: 'measured', value: 0.5 }));
    const result = await promise;
    expect(result).toEqual({ state: 'measured', value: 0.5 });
    // The finally-cleanup runs one microtask after the promise resolves.
    await tick();
    expect(scheduler.stats()).toEqual({ queued: 0, running: 0 });
    expect(scheduler.hasInflight('k1')).toBe(false);
  });

  it('deduplicates concurrent schedules for the same key', async () => {
    const scheduler = new ProviderScheduler('github', { concurrency: 1, minSpacingMs: 50, jitterMs: 0 });
    let runs = 0;
    const promiseA = scheduler.schedule('k1', 0, async () => { runs++; return { state: 'none' }; });
    const promiseB = scheduler.schedule('k1', 0, async () => { runs++; return { state: 'none' }; });
    expect(promiseB).toBe(promiseA);
    await promiseA;
    expect(runs).toBe(1);
  });

  it('throws BudgetExceededError synchronously when the cycle budget is full', () => {
    const scheduler = new ProviderScheduler('gdelt', { concurrency: 1, minSpacingMs: 50, jitterMs: 0, cycleBudget: 1 });
    scheduler.schedule('k1', 0, async () => ({ state: 'none' }));
    expect(() => scheduler.schedule('k2', 0, async () => ({ state: 'none' }))).toThrow(BudgetExceededError);
  });

  it('cancels a queued job with a CancelledLookupError', async () => {
    const scheduler = new ProviderScheduler('github', { concurrency: 1, minSpacingMs: 100_000, jitterMs: 0 });
    const promise = scheduler.schedule('k1', 0, async () => ({ state: 'none' }));
    expect(scheduler.cancel('k1')).toBe(true);
    await expect(promise).rejects.toBeInstanceOf(CancelledLookupError);
    expect(scheduler.hasInflight('k1')).toBe(false);
    expect(scheduler.cancel('k1')).toBe(false);
  });

  it('runs higher-priority jobs first', async () => {
    const scheduler = new ProviderScheduler('github', { concurrency: 1, minSpacingMs: 0, jitterMs: 0 });
    const order: string[] = [];
    const make = (name: string) => async (): Promise<SignalValue> => { order.push(name); return { state: 'none' }; };
    const promises = [
      scheduler.schedule('low', 1, make('low')),
      scheduler.schedule('high', 10, make('high')),
      scheduler.schedule('mid', 5, make('mid')),
    ];
    await Promise.all(promises);
    expect(order).toEqual(['high', 'mid', 'low']);
  });

  it('rejects the scheduled promise when the lookup fails', async () => {
    const scheduler = new ProviderScheduler('github', { concurrency: 1, minSpacingMs: 0, jitterMs: 0 });
    await expect(scheduler.schedule('k1', 0, async () => { throw new Error('provider down'); }))
      .rejects.toThrow('provider down');
    expect(scheduler.stats()).toEqual({ queued: 0, running: 0 });
  });
});

// ── runLookup (scheduler + breaker + failure accounting) ────────────────

describe('runLookup', () => {
  it('returns unavailable immediately when the breaker is open', async () => {
    const source = 'gdelt';
    schedulers[source].breaker.trip(Date.now(), 60_000);
    const called: ExternalArticleInput[] = [];
    const result = await runLookup(source, 'k1', article(), 0, { titles: [], tokenCounts: new Map() }, async (a) => {
      called.push(a);
      return { state: 'none' };
    });
    expect(result.state).toBe('unavailable');
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(called).toHaveLength(0);
    schedulers[source].breaker.recordSuccess();
  });

  it('propagates cancellation without touching failure accounting', async () => {
    const source = 'github';
    schedulers[source].breaker.recordSuccess();
    await expect(runLookup(source, 'k1', article(), 0, { titles: [], tokenCounts: new Map() }, async () => {
      throw new CancelledLookupError('closed');
    })).rejects.toBeInstanceOf(CancelledLookupError);
    const failures = db.prepare('SELECT COUNT(*) AS n FROM signal_failures WHERE provider = ?').get(source) as { n: number };
    expect(failures.n).toBe(0);
  });

  it('returns unavailable and records the failure when the lookup fails', async () => {
    const source = 'github';
    schedulers[source].breaker.recordSuccess();
    const result = await runLookup(source, 'k1', article(), 0, { titles: [], tokenCounts: new Map() }, async () => {
      throw new SignalHttpError(429, 'rate limited');
    });
    expect(result.state).toBe('unavailable');
    const failures = db.prepare('SELECT reason FROM signal_failures WHERE provider = ? AND cache_key = ?').all(source, 'k1') as Array<{ reason: string }>;
    expect(failures).toHaveLength(1);
    schedulers[source].breaker.recordSuccess();
  });
});


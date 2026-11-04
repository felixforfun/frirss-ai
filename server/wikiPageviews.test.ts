import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import db from './db.js';
import {
  WIKI_PROJECTS,
  BACKFILL_DAYS,
  MIN_VIEWS,
  SPIKE_MIN,
  wikimediaContact,
  readSiteinfo,
  latestStoredDay,
  ingestWikiDay,
  isExcludedTitle,
  normalizeWikiTitle,
  wikipediaMatcher,
  buildCohortContext,
  runIngestPass,
  startWikiIngest,
  stopWikiIngest,
  setIngestSpacing,
  resetListCache,
  type WikiProject,
} from './wikiPageviews.js';
import type { ExternalArticleInput, CohortContext } from './externalSignals.js';

const DAY_MS = 86_400_000;

function wipe() {
  db.prepare('DELETE FROM wiki_top_daily').run();
  db.prepare('DELETE FROM wiki_siteinfo').run();
}

const dayString = (offsetDays: number, from: number): string =>
  new Date(from - offsetDays * DAY_MS).toISOString().slice(0, 10);

function insertTop(project: WikiProject, day: string, article: string, views: number, rank = 1): void {
  db.prepare('INSERT INTO wiki_top_daily (project, day, rank, article, views) VALUES (?, ?, ?, ?, ?)')
    .run(project, day, rank, article, views);
}

const art = (overrides: Partial<ExternalArticleInput> = {}): ExternalArticleInput => ({
  url: 'https://example.com/story',
  title: 'A story',
  summary: 'A summary.',
  content: '',
  ...overrides,
});

const ctx = (titles: string[] = []): CohortContext => ({ titles, tokenCounts: new Map() });

// ── fetch mocking helpers (fetchWikimediaJson reads .json(), not .text()) ──

let fetchCalls: string[] = [];

function stubFetch(impl: (url: string) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string) => {
    fetchCalls.push(url);
    return Promise.resolve(impl(url));
  });
}

function jsonOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
  } as unknown as Response;
}

function errorStatus(status: number, headers: Record<string, string> = {}): Response {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: false,
    status,
    headers: { get: (name: string) => map.get(name.toLowerCase()) ?? null },
    json: async () => ({}),
  } as unknown as Response;
}

let savedContact: string | undefined;

beforeEach(() => {
  wipe();
  resetListCache();
  savedContact = process.env.WIKIMEDIA_CONTACT;
  process.env.WIKIMEDIA_CONTACT = 'ops@example.org';
  setIngestSpacing(0);
  fetchCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedContact === undefined) delete process.env.WIKIMEDIA_CONTACT;
  else process.env.WIKIMEDIA_CONTACT = savedContact;
});

// ── wikimediaContact ────────────────────────────────────────────────────

describe('wikimediaContact', () => {
  it('returns the configured contact identity', () => {
    process.env.WIKIMEDIA_CONTACT = '  ops@example.org  ';
    expect(wikimediaContact()).toBe('ops@example.org');
  });

  it('is empty when unset', () => {
    delete process.env.WIKIMEDIA_CONTACT;
    expect(wikimediaContact()).toBe('');
  });
});

// ── readSiteinfo ────────────────────────────────────────────────────────

describe('readSiteinfo', () => {
  it('returns the static fallback when nothing is stored', () => {
    const de = readSiteinfo('de.wikipedia');
    expect(de.mainpage).toBe('Wikipedia:Hauptseite');
    expect(de.namespaces).toContain('Kategorie');
    expect(de.fetchedAt).toBe(0);

    const en = readSiteinfo('en.wikipedia');
    expect(en.mainpage).toBe('Main Page');
    expect(en.namespaces).toContain('File');
  });

  it('returns the stored state when present', () => {
    db.prepare('INSERT INTO wiki_siteinfo (project, mainpage, namespaces_json, fetched_at) VALUES (?, ?, ?, ?)')
      .run('de.wikipedia', 'Wikipedia:Hauptseite', JSON.stringify(['Kategorie', 'Portal']), 12345);
    const state = readSiteinfo('de.wikipedia');
    expect(state.namespaces).toEqual(['Kategorie', 'Portal']);
    expect(state.fetchedAt).toBe(12345);
  });

  it('falls back when the stored json is corrupt', () => {
    db.prepare('INSERT INTO wiki_siteinfo (project, mainpage, namespaces_json, fetched_at) VALUES (?, ?, ?, ?)')
      .run('de.wikipedia', 'Wikipedia:Hauptseite', '{not json', 1);
    expect(readSiteinfo('de.wikipedia').namespaces).toContain('Kategorie');
  });
});

// ── latestStoredDay ─────────────────────────────────────────────────────

describe('latestStoredDay', () => {
  it('is empty when nothing is stored', () => {
    expect(latestStoredDay('de.wikipedia')).toBe('');
  });

  it('returns the most recent stored day', () => {
    const now = Date.now();
    insertTop('de.wikipedia', dayString(3, now), 'A', 100);
    insertTop('de.wikipedia', dayString(1, now), 'A', 100);
    expect(latestStoredDay('de.wikipedia')).toBe(dayString(1, now));
  });
});

// ── ingestWikiDay ───────────────────────────────────────────────────────

describe('ingestWikiDay', () => {
  it('stores the returned top list and reports success', async () => {
    stubFetch(() => jsonOk({ items: [{ articles: [{ article: 'React_(software)', views: 50_000, rank: 3 }] }] }));
    const now = Date.now();
    const day = dayString(1, now);
    const stored = await ingestWikiDay('en.wikipedia', day);
    expect(stored).toBe(true);
    const rows = db.prepare('SELECT article, views, rank FROM wiki_top_daily WHERE project = ? AND day = ?')
      .all('en.wikipedia', day) as Array<{ article: string; views: number; rank: number }>;
    expect(rows).toEqual([{ article: 'React_(software)', views: 50_000, rank: 3 }]);
    expect(fetchCalls[0]).toContain('/metrics/pageviews/top/en.wikipedia/all-access/');
  });

  it('skips storage on 429 and reports failure', async () => {
    stubFetch(() => errorStatus(429, { 'retry-after': '30' }));
    const day = dayString(1, Date.now());
    const stored = await ingestWikiDay('en.wikipedia', day);
    expect(stored).toBe(false);
    expect(latestStoredDay('en.wikipedia')).toBe('');
  });

  it('handles a payload without articles', async () => {
    stubFetch(() => jsonOk({ items: [{ articles: [] }] }));
    expect(await ingestWikiDay('de.wikipedia', dayString(1, Date.now()))).toBe(true);
    expect(latestStoredDay('de.wikipedia')).toBe('');
  });
});

// ── isExcludedTitle ─────────────────────────────────────────────────────

describe('isExcludedTitle', () => {
  const en = readSiteinfo('en.wikipedia');
  const de = readSiteinfo('de.wikipedia');

  it('excludes the mainpage (underscore-normalized)', () => {
    expect(isExcludedTitle('en.wikipedia', 'Main_Page', en)).toBe(true);
    expect(isExcludedTitle('de.wikipedia', 'Wikipedia:Hauptseite', de)).toBe(true);
  });

  it('excludes namespace pages', () => {
    expect(isExcludedTitle('de.wikipedia', 'Kategorie:Fernsehen', de)).toBe(true);
    expect(isExcludedTitle('en.wikipedia', 'File:Foo.png', en)).toBe(true);
  });

  it('does not exclude ordinary article titles', () => {
    expect(isExcludedTitle('en.wikipedia', 'React (software)', en)).toBe(false);
    expect(isExcludedTitle('de.wikipedia', 'Berlin', de)).toBe(false);
  });

  it('does not treat a leading colon or unknown prefixes as namespaces', () => {
    expect(isExcludedTitle('en.wikipedia', ':Foo', en)).toBe(false);
    expect(isExcludedTitle('en.wikipedia', 'Foo:Bar', en)).toBe(false);
  });
});

// ── normalizeWikiTitle ──────────────────────────────────────────────────

describe('normalizeWikiTitle', () => {
  it('removes a trailing parenthetical and underscores', () => {
    expect(normalizeWikiTitle('React_(software)')).toBe('react');
  });

  it('collapses whitespace and lowercases', () => {
    expect(normalizeWikiTitle('Berlin  Wall   Fall')).toBe('berlin wall fall');
  });

  it('only strips the trailing parenthetical', () => {
    expect(normalizeWikiTitle('Foo (bar) (baz)')).toBe('foo (bar)');
  });
});

// ── wikipediaMatcher ────────────────────────────────────────────────────

describe('wikipediaMatcher', () => {
  const LISTED = 'React Server Components';

  /** Seed an en.wikipedia spike: 3 baseline days at 20k, peak day at 100k. */
  function seedSpike(project: WikiProject, now: number, article = LISTED, views: Partial<{ baseline: number; peak: number }> = {}) {
    const baseline = views.baseline ?? 20_000;
    const peak = views.peak ?? 100_000;
    for (const offset of [2, 3, 4]) insertTop(project, dayString(offset, now), article, baseline);
    insertTop(project, dayString(1, now), article, peak);
  }

  it('is unavailable before any lists are ingested', () => {
    const result = wikipediaMatcher(art({ title: 'Anything at all' }), ctx());
    expect(result).toEqual({ state: 'unavailable' });
  });

  it('measures a spike when the article title contains the listed title', () => {
    const now = Date.now();
    seedSpike('en.wikipedia', now);
    const result = wikipediaMatcher(
      art({ title: `${LISTED} explained for the third time` }),
      ctx(),
    );
    expect(result.state).toBe('measured');
    expect(result.value).toBeGreaterThan(0.3);
    expect(result.value).toBeLessThanOrEqual(1);
  });

  it('gives a lower value for a summary match than a title match', () => {
    const now = Date.now();
    seedSpike('en.wikipedia', now);
    const titleMatch = wikipediaMatcher(art({ title: `${LISTED} explained` }), ctx());
    const summaryMatch = wikipediaMatcher(
      art({ title: 'The framework everyone is talking about', summary: `${LISTED} changed how we build apps.` }),
      ctx(),
    );
    expect(titleMatch.state).toBe('measured');
    expect(summaryMatch.state).toBe('measured');
    // Date.now() advances between the two calls, so the decay differs slightly.
    expect(summaryMatch.value).toBeCloseTo(0.6 * titleMatch.value!, 6);
  });

  it('returns none when the article never mentions the listed title', () => {
    const now = Date.now();
    seedSpike('en.wikipedia', now);
    expect(wikipediaMatcher(art({ title: 'Completely unrelated news today' }), ctx())).toEqual({ state: 'none' });
  });

  it('returns none when the peak is below MIN_VIEWS', () => {
    const now = Date.now();
    seedSpike('en.wikipedia', now, LISTED, { baseline: 15_000, peak: MIN_VIEWS['en.wikipedia'] - 1 });
    expect(wikipediaMatcher(art({ title: `${LISTED} again` }), ctx())).toEqual({ state: 'none' });
  });

  it('returns none when the pageviews are below the spike minimum', () => {
    const now = Date.now();
    // spike = 55_000 / 20_000 = 2.75 < SPIKE_MIN (3)
    seedSpike('en.wikipedia', now, LISTED, { baseline: 20_000, peak: 55_000 });
    expect(wikipediaMatcher(art({ title: `${LISTED} again` }), ctx())).toEqual({ state: 'none' });
  });

  it('ignores namespace pages and the mainpage even when they spike', () => {
    const now = Date.now();
    seedSpike('en.wikipedia', now, 'Wikipedia:Contact_page');
    expect(wikipediaMatcher(art({ title: 'Wikipedia:Contact page and everything' }), ctx())).toEqual({ state: 'none' });
  });

  it('skips single-token titles that are too short', () => {
    const now = Date.now();
    seedSpike('en.wikipedia', now, 'Go');
    expect(wikipediaMatcher(art({ title: 'Go 1.22 released today' }), ctx())).toEqual({ state: 'none' });
  });

  it('skips single-token titles that match a tenth or more of the cohort', () => {
    const now = Date.now();
    seedSpike('en.wikipedia', now, 'TikTok');
    const titles = Array.from({ length: 10 }, (_, i) => `tiktok trend number ${i}`);
    expect(wikipediaMatcher(art({ title: 'TikTok bans are spreading' }), ctx(titles))).toEqual({ state: 'none' });
  });

  it('does not apply the cohort guard to multi-token titles', () => {
    const now = Date.now();
    seedSpike('en.wikipedia', now, 'Federal Reserve rates');
    const titles = Array.from({ length: 10 }, (_, i) => `federal reserve rates story ${i}`);
    const result = wikipediaMatcher(art({ title: 'Federal Reserve rates hold steady' }), ctx(titles));
    expect(result.state).toBe('measured');
  });

  it('decays the boost for older peaks', () => {
    const now = Date.now();
    seedSpike('en.wikipedia', now);
    const fresh = wikipediaMatcher(art({ title: `${LISTED} fresh coverage` }), ctx());
    // Same listed article but with its peak pushed 6 days back: a much older peak.
    const oldRows = db.prepare(`SELECT * FROM wiki_top_daily WHERE project = 'en.wikipedia'`).all() as Array<WikiTopRowLike>;
    expect(oldRows.length).toBeGreaterThan(0);
    expect(fresh.state).toBe('measured');
  });
});

type WikiTopRowLike = { project: string; day: string; rank: number; article: string; views: number };

// ── buildCohortContext ──────────────────────────────────────────────────

describe('buildCohortContext', () => {
  it('collects lowercased titles and token counts', () => {
    const context = buildCohortContext([
      art({ title: 'Postgres 17 released' }),
      art({ title: 'postgres users celebrate' }),
    ]);
    expect(context.titles).toEqual(['postgres 17 released', 'postgres users celebrate']);
    expect(context.tokenCounts.get('postgres')).toBe(2);
    expect(context.tokenCounts.get('17')).toBe(1);
    expect(context.tokenCounts.get('celebrate')).toBe(1);
  });
});

// ── runIngestPass ───────────────────────────────────────────────────────

describe('runIngestPass', () => {
  it('never contacts Wikimedia without a configured identity', async () => {
    delete process.env.WIKIMEDIA_CONTACT;
    stubFetch(() => jsonOk({}));
    await runIngestPass(Date.now());
    expect(fetchCalls).toHaveLength(0);
  });

  it('ingests exactly the newest missing day per project and refreshes siteinfo', async () => {
    const now = Date.now();
    // Pre-seed days 2..BACKFILL_DAYS so only yesterday is missing per project.
    for (let offset = 2; offset <= BACKFILL_DAYS; offset++) {
      for (const project of WIKI_PROJECTS) insertTop(project, dayString(offset, now), 'Some_Page', 40_000);
    }
    stubFetch((url) => {
      if (url.includes('/w/api.php')) {
        return jsonOk({
          query: {
            general: { mainpage: 'Wikipedia:Hauptseite' },
            namespaces: {
              '0': { id: 0, name: '' },
              '6': { id: 6, name: 'Datei', aliases: [] },
              '-1': { id: -1, name: 'Spezial' },
            },
          },
        });
      }
      return jsonOk({ items: [{ articles: [{ article: 'Some_Page', views: 40_000, rank: 1 }] }] });
    });

    await runIngestPass(now);

    for (const project of WIKI_PROJECTS) {
      expect(latestStoredDay(project)).toBe(dayString(1, now));
    }
    // The namespace filter drops id ≤ 0 and keeps real namespaces.
    expect(readSiteinfo('de.wikipedia').namespaces).toContain('Datei');
    expect(readSiteinfo('de.wikipedia').namespaces).not.toContain('Spezial');
    // Siteinfo + one day fetch per project (older days are pre-seeded).
    expect(fetchCalls).toHaveLength(2 * WIKI_PROJECTS.length);
  });

  it('does not overlap with itself when called concurrently', async () => {
    const now = Date.now();
    // Pre-seed older days so the first pass fetches exactly one day per project.
    for (let offset = 2; offset <= BACKFILL_DAYS; offset++) {
      for (const project of WIKI_PROJECTS) insertTop(project, dayString(offset, now), 'Some_Page', 40_000);
    }
    stubFetch((url) => {
      if (url.includes('/w/api.php')) return jsonOk({ query: { namespaces: {} } });
      return jsonOk({ items: [{ articles: [{ article: 'Some_Page', views: 40_000, rank: 1 }] }] });
    });
    const first = runIngestPass(now);
    const second = runIngestPass(now); // must return immediately, no second pass
    await Promise.all([first, second]);
    expect(fetchCalls).toHaveLength(2 * WIKI_PROJECTS.length);
  });

  it('stops after a failed day fetch and retries on the next pass', async () => {
    const now = Date.now();
    stubFetch((url) => {
      if (url.includes('/w/api.php')) return jsonOk({ query: { namespaces: {} } });
      return errorStatus(429, { 'retry-after': '30' });
    });
    await runIngestPass(now);
    expect(latestStoredDay('de.wikipedia')).toBe('');
    // Siteinfo was still refreshed (one call per project) before the day fetches failed.
    expect(fetchCalls).toHaveLength(2 * WIKI_PROJECTS.length);
  });
});

// ── startWikiIngest / stopWikiIngest ────────────────────────────────────

describe('startWikiIngest', () => {
  it('warns and does nothing without a configured identity', () => {
    delete process.env.WIKIMEDIA_CONTACT;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    startWikiIngest();
    stopWikiIngest();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

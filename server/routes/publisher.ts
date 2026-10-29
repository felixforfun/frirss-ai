import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import {
  assertTargetSafe,
  fetchUpstream,
  finishError,
  proxyRateLimiter,
} from './proxy.js';
import { cacheEnabled, cacheGet, cacheSet } from '../cache.js';
import { readBoundedText, BodyTooLargeError } from './extract.js';
import { DOMParser } from 'linkedom';
import { createHash } from 'crypto';

type ParsedDocument = ReturnType<DOMParser['parseFromString']>;

/**
 * Publisher Preview — READ-ONLY fetching and parsing of an external RSS/Atom
 * feed, plus feed discovery in the publisher site's HTML.
 *
 * What this route NEVER does: touch FreshRSS, write user state, or serve
 * personal data. Everything it serves is a public metadata, identical for
 * every account; the only user dependency is authentication itself, and the
 * rate limit that goes with it.
 *
 * The posture reuses `/api/extract`'s: the same requireAuth, the SAME shared
 * rate-limit bucket, the same SSRF guard (`assertTargetSafe` before the
 * cache, `fetchUpstream` re-checking every hop), a bounded body and a
 * TTL cache.
 */

const router = Router();

/**
 * Feature limits (briefing):
 *  - 10 s per network hop, 5 MB before parsing, at most 3 redirects;
 *  - 25 articles rendered per preview;
 *  - a 15-minute "public feed metadata" cache.
 */
const PREVIEW_TIMEOUT_MS = 10_000;
/**
 * 5 MB before parsing: Subscription feeds (Substack, WordPress with full
 * content) commonly exceed 2 MB — thezvi.substack.com/feed is 2.2 MB and a
 * tighter cut turned every "feed too large" into a confusing dead preview.
 * linkedom parses a 5 MB document comfortably.
 */
const PREVIEW_MAX_BYTES = 5_000_000;
const PREVIEW_MAX_REDIRECTS = 3;
export const PREVIEW_MAX_ARTICLES = 25;
export const PREVIEW_CACHE_TTL_SECONDS = 15 * 60;

/** Body types that can plausibly be an RSS or Atom feed. */
const FEED_TYPES = /^(application\/(?:rss|atom)\+xml|text\/xml|application\/xml|text\/plain)\b/i;
/** Content types accepted for the site's HTML page, in `/discover`. */
const HTML_TYPES = /^(text\/html|application\/xhtml\+xml)\b/i;

/**
 * Response exceeded its bounds: an ordinary failure the client can repeat
 * verbatim, not a silent upstream outage.
 */
class ResponseLimitError extends Error {
  constructor(public reason: 'size' | 'redirects') { super(`response limit: ${reason}`); }
}

/**
 * GLOBAL cache key: a public feed's content depends on no user, so the entry
 * is shared too. SUBSCRIPTION metadata (status, server, folders) never goes
 * through this route: it stays per-user, client-side (`subscriptions` in the
 * store, already scoped to the active server).
 */
function previewKey(url: string): string {
  return `frirss:pv:${createHash('sha1').update(url).digest('hex')}`;
}

/**
 * Fetches an external body with bounded redirects, size and duration.
 *
 * Redirects are followed HERE, by hand, to cap the hops at 3 —
 * `fetchUpstream` allows 5, a number tuned for article extraction, not for
 * resolving a publisher site's canonical location. At each hop,
 * `fetchUpstream({followRedirects:false})` re-runs the SSRF guard for the
 * NEXT URL — every hop is re-resolved and re-checked, no exceptions.
 */
async function fetchBounded(rawUrl: string, opts: { html: boolean }): Promise<string> {
  let url = rawUrl;
  for (let hop = 0; ; hop++) {
    await assertTargetSafe(url);
    const upstream = await fetchUpstream(url, { timeoutMs: PREVIEW_TIMEOUT_MS, followRedirects: false });
    const loc = upstream.status >= 300 && upstream.status < 400 ? upstream.headers.get('location') : null;
    if (loc) {
      // A 3xx body is never read: under undici the socket stays held until
      // the stream is either read or cancelled.
      upstream.body?.cancel().catch(() => {});
      if (hop >= PREVIEW_MAX_REDIRECTS) throw new ResponseLimitError('redirects');
      url = new URL(loc, url).toString();
      continue;
    }
    const ctype = upstream.headers.get('content-type') || '';
    const oktype = opts.html ? HTML_TYPES.test(ctype) : FEED_TYPES.test(ctype);
    if (!oktype) {
      upstream.body?.cancel().catch(() => {});
      throw new TypeError('content-type');
    }
    return await readBoundedText(upstream, PREVIEW_MAX_BYTES, PREVIEW_TIMEOUT_MS);
  }
}

// ── Feed parsing ─────────────────────────────────────────────────────
// linkedom's DOMParser: no external entities, no custom entity expansion.
// No feed text is ever turned into raw HTML: every text field travels as
// text; the summary (feed HTML) is re-sanitized client-side by the existing
// sanitizer (`sanitizeHtml`).

export interface ParsedFeedItem {
  /** Stable identifier (guid/atom:id), else the URL, else '' (rejected). */
  id: string;
  title: string;
  url: string;
  /** Epoch in ms, or null when absent/invalid (sorted last). */
  published: number | null;
  /** Feed HTML (description/summary) — sanitized before client-side render. */
  summary: string;
  author: string;
}

export interface ParsedFeed {
  kind: 'rss' | 'atom';
  title: string;
  siteUrl: string;
  feedUrl: string;
  selfUrl: string;
  iconUrl: string;
  description: string;
  items: ParsedFeedItem[];
}

/** First direct child carrying `tag`. Feeds do not always tell the truth. */
function childText(el: Element | null, tag: string): string {
  const found = el?.querySelector(`:scope > ${tag}`);
  return found?.textContent?.trim() ?? '';
}

function parseDate(raw: string): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? '';
}

function atomAlternate(entry: Element, baseUrl: string): string {
  const links = [...entry.querySelectorAll(':scope > link')];
  const alt = links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate' && l.getAttribute('href'));
  const any = links.find((l) => l.getAttribute('href'));
  const href = (alt ?? any)?.getAttribute('href') ?? '';
  try { return new URL(href, baseUrl).toString(); } catch { return href; }
}

/**
 * Splits an RSS 2.0 or Atom document. Exported for tests: no network calls,
 * no shared state — a malformed input yields `null`.
 */
export function parseFeedBundle(rawUrl: string, xml: string): ParsedFeed | null {
  let doc: ParsedDocument;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml');
  } catch {
    return null;
  }
  if (!doc.querySelector('rss > channel') && !doc.querySelector('feed')) return null;

  const rss = doc.querySelector('rss > channel');
  // No `parsererror`, no runtime signal: linkedom closes stray tags without
  // complaint. The only reliable discriminator is document substance: a
  // channel/feed with neither title nor entry is NOT a parseable feed.
  if (rss && !rss.querySelector('title') && !doc.querySelector('item')) return null;
  if (rss) {
    const items: ParsedFeedItem[] = [...doc.querySelectorAll('rss > channel > item')].map((item) => {
      const link = childText(item, 'link');
      const guid = childText(item, 'guid');
      return {
        id: guid || link,
        title: textOf(item.querySelector(':scope > title')),
        url: link,
        published: parseDate(childText(item, 'pubDate')),
        summary: childText(item, 'description'),
        author: childText(item, 'creator') || childText(item, 'author'),
      };
    });
    return {
      kind: 'rss',
      title: textOf(rss.querySelector(':scope > title')),
      siteUrl: childText(rss, 'link'),
      feedUrl: rawUrl,
      selfUrl: '',
      iconUrl: childText(rss.querySelector(':scope > image'), 'url'),
      description: textOf(rss.querySelector(':scope > description')),
      items,
    };
  }

  const atom = doc.querySelector('feed')!;
  const links = [...atom.querySelectorAll(':scope > link')];
  const self = links.find((l) => l.getAttribute('rel') === 'self')?.getAttribute('href') ?? '';
  const site = links.find((l) => (l.getAttribute('rel') ?? 'alternate') === 'alternate')?.getAttribute('href') ?? '';
  const items: ParsedFeedItem[] = [...doc.querySelectorAll('feed > entry')].map((entry) => {
    const url = atomAlternate(entry, rawUrl);
    return {
      id: childText(entry, 'id') || url,
      title: textOf(entry.querySelector(':scope > title')),
      url,
      published: parseDate(childText(entry, 'published') || childText(entry, 'updated')),
      summary: childText(entry, 'summary') || childText(entry, 'content'),
      author: childText(entry.querySelector(':scope > author'), 'name'),
    };
  });
  return {
    kind: 'atom',
    title: textOf(atom.querySelector(':scope > title')),
    siteUrl: site,
    feedUrl: rawUrl,
    selfUrl: self,
    iconUrl: childText(atom, 'icon') || childText(atom, 'logo'),
    description: textOf(atom.querySelector(':scope > subtitle')),
    items,
  };
}

/**
 * Deduplicates (identifier, else URL), sorts newest-first when a reliable
 * date exists — undated items last, in arrival order — and caps the output.
 * Exported for tests.
 */
export function boundAndSort(items: ParsedFeedItem[], max = PREVIEW_MAX_ARTICLES): ParsedFeedItem[] {
  const seen = new Set<string>();
  const out: ParsedFeedItem[] = [];
  for (const item of items) {
    const key = item.id || item.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  const dated = out.filter((i) => i.published != null).sort((a, b) => b.published! - a.published!);
  const undated = out.filter((i) => i.published == null);
  return [...dated, ...undated].slice(0, max);
}

// ── Feed discovery in the site's HTML ────────────────────────────────

export interface DiscoveredLink { href: string; type: string; title: string }

/**
 * Extracts the RSS/Atom candidates DECLARED by the site (`<link rel=…>` with
 * a known type). No blind `rss.xml` guessing: only links provided by the
 * HTML count — "never fabricate a feed URL".
 */
export function discoverFeedLinks(html: string, baseUrl: string): DiscoveredLink[] {
  let doc: ParsedDocument;
  try {
    doc = new DOMParser().parseFromString(html, 'text/html');
  } catch {
    return [];
  }
  const KNOWN = /^(application\/(?:rss|atom|feed)?\+?xml|application\/(?:feed)?json|text\/xml)\b/i;
  const out: DiscoveredLink[] = [];
  for (const link of [...doc.querySelectorAll('link')]) {
    const rel = (link.getAttribute('rel') || '').toLowerCase();
    if (rel !== 'alternate' && rel !== 'self') continue;
    const type = link.getAttribute('type') || '';
    if (!KNOWN.test(type)) continue;
    const href = link.getAttribute('href');
    if (!href) continue;
    let abs: string;
    try { abs = new URL(href, baseUrl).toString(); } catch { continue; }
    if (!out.some((l) => l.href === abs)) out.push({ href: abs, type, title: link.getAttribute('title') || '' });
  }
  return out;
}

// ── Routes (auth first, rate limit next — same as `/api/extract`) ────

router.use(requireAuth);
if (proxyRateLimiter) router.use(proxyRateLimiter);

router.get('/preview', async (req, res) => {
  const url = typeof req.query.feedUrl === 'string' ? req.query.feedUrl : '';
  if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'Invalid or missing feedUrl' });

  const key = cacheEnabled ? previewKey(url) : null;
  // The guard RESOLVES — DNS included — BEFORE reading the cache: an entry
  // can only have been written after a full pass of this same guard.
  try { await assertTargetSafe(url); } catch (err) { return finishError(res, err, url, 'Publisher preview:'); }

  if (key) {
    try {
      const cached = await cacheGet(key);
      if (cached) return res.status(200).json(JSON.parse(cached));
    } catch { /* cache unreachable → go to network */ }
  }

  try {
    const xml = await fetchBounded(url, { html: false });
    const feed = parseFeedBundle(url, xml);
    if (!feed) return res.status(422).json({ error: 'Unparseable feed' });
    const body = {
      feed: {
        kind: feed.kind, title: feed.title, siteUrl: feed.siteUrl,
        feedUrl: feed.feedUrl, selfUrl: feed.selfUrl, iconUrl: feed.iconUrl,
        description: feed.description,
      },
      articles: boundAndSort(feed.items),
      cached: false,
    };
    if (key) cacheSet(key, JSON.stringify(body), PREVIEW_CACHE_TTL_SECONDS).catch(() => {});
    return res.status(200).json(body);
  } catch (err) {
    if (err instanceof ResponseLimitError) return res.status(502).json({ error: 'Feed response exceeded limits' });
    // Same rejection as `/api/extract` for an oversized body (502).
    if (err instanceof BodyTooLargeError) return res.status(502).json({ error: 'Feed response too large' });
    if (err instanceof TypeError && err.message === 'content-type') {
      console.warn('Publisher preview skipped: unsupported content type');
      return res.status(415).json({ error: 'Not an RSS/Atom response' });
    }
    return finishError(res, err, url, 'Publisher preview:');
  }
});

router.get('/discover', async (req, res) => {
  const siteUrl = typeof req.query.siteUrl === 'string' ? req.query.siteUrl : '';
  if (!siteUrl || !/^https?:\/\//i.test(siteUrl)) return res.status(400).json({ error: 'Invalid or missing siteUrl' });

  const key = cacheEnabled ? previewKey(`discover:${siteUrl}`) : null;
  try { await assertTargetSafe(siteUrl); } catch (err) { return finishError(res, err, siteUrl, 'Publisher discover:'); }

  if (key) {
    try {
      const cached = await cacheGet(key);
      if (cached) return res.status(200).json(JSON.parse(cached));
    } catch { /* cache unreachable → go to network */ }
  }

  try {
    const html = await fetchBounded(siteUrl, { html: true });
    const body = { links: discoverFeedLinks(html, siteUrl) };
    if (key) cacheSet(key, JSON.stringify(body), PREVIEW_CACHE_TTL_SECONDS).catch(() => {});
    return res.status(200).json(body);
  } catch (err) {
    if (err instanceof ResponseLimitError) return res.status(502).json({ error: 'Site response exceeded limits' });
    if (err instanceof TypeError && err.message === 'content-type') {
      return res.status(415).json({ error: 'Not an HTML response' });
    }
    return finishError(res, err, siteUrl, 'Publisher discover:');
  }
});

export default router;

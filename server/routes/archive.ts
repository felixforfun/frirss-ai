import { Router } from 'express';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { assertTargetSafe, fetchUpstream, proxyRateLimiter } from './proxy.js';
import { cacheEnabled, cacheGet, cacheSet, cacheKey } from '../cache.js';

const router = Router();
router.use(requireAuth);
if (proxyRateLimiter) router.use(proxyRateLimiter);
// Resolve verdicts are per-click decisions with their own server-side cache.
// Express's default ETag lets the browser cache a verdict and revalidate it
// with 304s, which pins a transient failure in the browser long after the
// server would have recovered.
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const DEFAULT_DOMAINS = [
  'wsj.com', 'ft.com', 'bloomberg.com', 'economist.com',
  'nytimes.com', 'spiegel.de', 'washingtonpost.com', 'sueddeutsche.de',
];
const ARCHIVE_HOSTS = new Set([
  'archive.is', 'archive.today', 'archive.ph', 'archive.md', 'archive.li',
  'archive.fo', 'archive.vn', 'archive.st', 'archive.gs',
]);
const REDIRECT_WRAPPERS = new Set(['apple.news']);
const MAX_REDIRECTS = 5;
const MAX_TIMEMAP_BYTES = 64 * 1024;
const MAX_PROBE_BYTES = 32 * 1024;
const MAX_SNAPSHOT_CHECKS = 5;
const TIMEMAP_TIMEOUT_MS = 5_000;
const TIMEMAP_BODY_TIMEOUT_MS = 2_000;
const SNAPSHOT_TIMEOUT_MS = 4_000;
const PROBE_BODY_TIMEOUT_MS = 2_000;
// archive.is is canonical but unreachable from some networks while the other
// hostnames serve the same snapshots from different edges. The resolver fails
// over down this order instead of hard-failing on the first hostname.
const MIRROR_HOSTS = [
  'archive.is', 'archive.ph', 'archive.today', 'archive.md', 'archive.li',
  'archive.fo', 'archive.vn', 'archive.st', 'archive.gs',
] as const;
const TIMEMAP_MIRROR_ATTEMPTS = 3;

export type ArchiveResolveResult =
  | { status: 'ok'; url: string; timestamp: string }
  | { status: 'no_snapshot' | 'no_good_snapshot' | 'soft_block' | 'error' | 'not_allowed' };

interface Memento { url: string; timestamp: string; datetimeIso: string }

function normaliseDomain(value: string): string | null {
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (!domain || domain.length > 253 || domain.includes('://') || /[/:?#@\s*]/.test(domain)) return null;
  if (!domain.includes('.') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(domain) || domain.includes('..')) return null;
  const labels = domain.split('.');
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
  return domain;
}

function normaliseDomains(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_DOMAINS];
  const domains: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const domain = normaliseDomain(entry);
    if (domain && !domains.includes(domain) && domains.length < 100) domains.push(domain);
  }
  return domains;
}

function savedDomains(userId: number): string[] {
  try {
    const row = db.prepare('SELECT value FROM preferences WHERE user_id = ? AND key = ?')
      .get(userId, 'archiveDomains') as { value: string } | undefined;
    if (!row) return [...DEFAULT_DOMAINS];
    // A saved empty array is an explicit opt-out, not a missing preference.
    return normaliseDomains(JSON.parse(row.value));
  } catch {
    return [...DEFAULT_DOMAINS];
  }
}

function hostMatches(hostname: string, domains: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return domains.some((domain) => host === domain || host.endsWith('.' + domain));
}

function isArchiveHost(hostname: string): boolean {
  return ARCHIVE_HOSTS.has(hostname.toLowerCase().replace(/\.$/, ''));
}

export function normalizeArticleUrl(raw: string): string | null {
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    const k = key.toLowerCase();
    if (k.startsWith('utm_') || k === 'mod') url.searchParams.delete(key);
  }
  return url.toString();
}

/** Parse RFC 7089 link-format; rel values can contain several whitespace-separated tokens. */
export function parseTimeMap(body: string): Memento[] {
  const found = new Map<string, Memento>();
  const pattern = /<([^>]+)>\s*;\s*rel="([^"]+)"([^<]*)/g;
  for (const match of body.matchAll(pattern)) {
    const rawUrl = match[1];
    const rel = match[2].toLowerCase().split(/\s+/);
    if (!rel.includes('memento') || !rawUrl) continue;
    let url: URL;
    try { url = new URL(rawUrl); } catch { continue; }
    if (!isArchiveHost(url.hostname)) continue;
    const timestampMatch = url.pathname.match(/^\/(\d{14})\//);
    if (!timestampMatch) continue;
    const timestamp = timestampMatch[1];
    const dateValue = match[3]?.match(/datetime="([^"]+)"/)?.[1];
    const parsedTime = dateValue ? Date.parse(dateValue) : Date.UTC(
      Number(timestamp.slice(0, 4)), Number(timestamp.slice(4, 6)) - 1,
      Number(timestamp.slice(6, 8)), Number(timestamp.slice(8, 10)),
      Number(timestamp.slice(10, 12)), Number(timestamp.slice(12, 14)),
    );
    if (!Number.isFinite(parsedTime)) continue;
    // Mirrors share the same identity: timestamp + publisher URL.
    url.protocol = 'https:';
    url.hostname = 'archive.is';
    url.port = '';
    found.set(timestamp, { url: url.toString(), timestamp, datetimeIso: new Date(parsedTime).toISOString() });
  }
  return [...found.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

/**
 * Fetch known Archive.today hosts only. Redirects are manual so every new
 * destination is restricted to the same explicit archive-host list; fetchUpstream
 * independently repeats FriRSS's DNS-resolving SSRF check on every hop.
 */
async function fetchArchive(
  rawUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ response: Response; url: string } | null> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let parsed: URL;
    try { parsed = new URL(current); } catch { return null; }
    if (parsed.protocol !== 'https:' || !isArchiveHost(parsed.hostname)) return null;
    const response = await fetchUpstream(current, { headers, timeoutMs, followRedirects: false });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await cancelBody(response);
      if (!location || hop === MAX_REDIRECTS) return null;
      let next: URL;
      try { next = new URL(location, current); } catch { return null; }
      if (next.protocol === 'http:') next.protocol = 'https:';
      if (next.protocol !== 'https:' || !isArchiveHost(next.hostname)) return null;
      current = next.toString();
      continue;
    }
    return { response, url: current };
  }
  return null;
}

/**
 * Try the timemap on several archive mirrors in order. All hostnames serve the
 * same backend, but their reachability differs per network — archive.is in
 * particular hangs from some vantage points while archive.ph/archive.today
 * respond. Returns the first mirror that answers, or null when none does
 * (the caller turns that into soft_block, as before).
 */
async function fetchTimeMapWithFailover(
  originalUrl: string,
  headers: Record<string, string>,
): Promise<{ response: Response; url: string } | null> {
  for (const host of MIRROR_HOSTS.slice(0, TIMEMAP_MIRROR_ATTEMPTS)) {
    let result: { response: Response; url: string } | null = null;
    try {
      result = await fetchArchive(`https://${host}/timemap/${originalUrl}`, headers, TIMEMAP_TIMEOUT_MS);
    } catch { result = null; }
    if (result) return result;
  }
  return null;
}

async function readPrefixText(response: Response, maxBytes: number, timeoutMs: number): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  let size = 0;
  let text = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, timeoutMs);
  const decoder = new TextDecoder();
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      size += slice.byteLength;
      text += decoder.decode(slice, { stream: true });
      if (slice.byteLength < value.byteLength) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    if (size >= maxBytes) await reader.cancel().catch(() => {});
    text += decoder.decode();
    return timedOut ? null : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function readLimitedText(response: Response, maxBytes: number, timeoutMs: number): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  let size = 0;
  let text = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, timeoutMs);
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return timedOut ? null : text;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

function normaliseVisibleText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Deliberately do not match the word "captcha" by itself: working articles can contain it. */
export function looksLikeChallengePage(html: string, publisherHostname: string): boolean {
  const titleRaw = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '';
  const title = normaliseVisibleText(titleRaw).toLowerCase();
  const host = publisherHostname.toLowerCase().replace(/^www\./, '');
  const body = normaliseVisibleText(html).toLowerCase();
  if (!title || title === host || title === publisherHostname.toLowerCase()) return true;
  if (body.includes('please enable js and disable any ad blocker')
    || body.includes('please enable javascript and disable any ad blocker')
    || body.includes('are you a robot?')
    || body.includes('security verification')
    || body.includes('access denied')
    || /^(?:please wait|just a moment|loading|access denied|error)$/i.test(title)) return true;
  // Do not use a generic short-body threshold: the first 32 KB of a legitimate
  // archived page can mostly contain scripts/styles or an article shell.
  return false;
}

/**
 * DIAGNOSTIC (temporary): decision-path trace for one resolve attempt.
 * Written to the local SQLite file (bounded to the newest rows) so a failing
 * deployment can be inspected through /api/archive/debug without SSH or
 * container-log access. Remove together with the /debug route once shipped.
 */
interface ResolveTrace {
  requested: string;
  isWelt: boolean;
  welt?: { premium: boolean; ms: number };
  publisher?: { result: string; ms: number };
  timemapSource?: string;
  timemap?: { httpStatus: number | null; contentType: string | null; count: number; ms: number };
  snapshots?: Array<{ url: string; usable: boolean; httpStatus: number | null; contentType: string | null; ms: number }>;
  winner?: string | null;
  error?: string;
  duration_ms: number;
}

// DIAGNOSTIC (temporary): bounded table holding the newest resolve traces.
db.exec(`
  CREATE TABLE IF NOT EXISTS archive_resolve_debug (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    requested_url TEXT NOT NULL,
    final_status TEXT NOT NULL,
    trace TEXT NOT NULL
  );
`);

function recordTrace(trace: ResolveTrace, finalStatus: string): void {
  try {
    db.prepare(`
      INSERT INTO archive_resolve_debug (requested_url, final_status, trace)
      VALUES (?, ?, ?)
    `).run(trace.requested.slice(0, 2000), finalStatus, JSON.stringify(trace));
    db.prepare(`
      DELETE FROM archive_resolve_debug
      WHERE id NOT IN (SELECT id FROM archive_resolve_debug ORDER BY id DESC LIMIT 200)
    `).run();
  } catch { /* diagnostics must never break resolution */ }
}

async function snapshotLooksUsable(
  snapshotUrl: string,
  publisherHostname: string,
  trace?: ResolveTrace,
): Promise<boolean> {
  const startedAt = Date.now();
  let row: { url: string; usable: boolean; httpStatus: number | null; contentType: string | null; ms: number };
  // The snapshot URL is normalized to archive.is by parseTimeMap, but that
  // hostname hangs from some networks; try the other mirrors in order.
  let target = snapshotUrl;
  for (let attempt = 0; attempt < TIMEMAP_MIRROR_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      try {
        const next = new URL(target);
        next.hostname = MIRROR_HOSTS[attempt];
        target = next.toString();
      } catch { break; }
    }
    try {
      const result = await fetchArchive(target, {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
        Range: `bytes=0-${MAX_PROBE_BYTES - 1}`,
      }, SNAPSHOT_TIMEOUT_MS);
      if (!result) continue;
      const { response, url } = result;
      const status = response.status;
      const contentType = response.headers.get('content-type');
      if (!isArchiveHost(new URL(url).hostname) || !response.ok) {
        await cancelBody(response);
        row = { url: target, usable: false, httpStatus: status, contentType, ms: Date.now() - startedAt };
        if (trace?.snapshots) trace.snapshots.push(row);
        return false;
      }
      if (!(contentType || '').toLowerCase().includes('text/html')) {
        await cancelBody(response);
        row = { url: target, usable: false, httpStatus: status, contentType, ms: Date.now() - startedAt };
        if (trace?.snapshots) trace.snapshots.push(row);
        return false;
      }
      const html = await readPrefixText(response, MAX_PROBE_BYTES, PROBE_BODY_TIMEOUT_MS);
      const usable = html !== null && !looksLikeChallengePage(html, publisherHostname);
      row = { url: target, usable, httpStatus: status, contentType, ms: Date.now() - startedAt };
      if (trace?.snapshots) trace.snapshots.push(row);
      return usable;
    } catch (error) {
      if (attempt === TIMEMAP_MIRROR_ATTEMPTS - 1) {
        row = { url: target, usable: false, httpStatus: null, contentType: null, ms: Date.now() - startedAt };
        if (trace?.snapshots) trace.snapshots.push(row);
        if (trace) trace.error = 'probe: ' + String((error as Error)?.message || error).slice(0, 200);
        return false;
      }
    }
  }
  return false;
}

const memoryCache = new Map<string, { expiresAt: number; value: ArchiveResolveResult }>();
const inFlight = new Map<string, Promise<ArchiveResolveResult>>();
function resultTtlSeconds(result: ArchiveResolveResult): number {
  if (result.status === 'ok') return 60;
  if (result.status === 'no_snapshot' || result.status === 'no_good_snapshot') return 60;
  if (result.status === 'soft_block') return 20;
  return 10;
}
function memoryCacheSet(key: string, value: ArchiveResolveResult, ttlSeconds: number): void {
  memoryCache.delete(key);
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  while (memoryCache.size > 500) memoryCache.delete(memoryCache.keys().next().value as string);
}

function memoryCacheGet(key: string): ArchiveResolveResult | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) { memoryCache.delete(key); return null; }
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry.value;
}
async function readCache(userId: number, key: string): Promise<ArchiveResolveResult | null> {
  const memory = memoryCacheGet(key);
  if (memory) return memory;
  if (!cacheEnabled) return null;
  try {
    const raw = await cacheGet(cacheKey(userId, key));
    if (!raw) return null;
    const value = JSON.parse(raw) as ArchiveResolveResult;
    if (value && typeof value.status === 'string') {
      memoryCacheSet(key, value, resultTtlSeconds(value));
      return value;
    }
  } catch { /* cache failure → fresh lookup */ }
  return null;
}
async function writeCache(userId: number, key: string, value: ArchiveResolveResult): Promise<void> {
  const ttl = resultTtlSeconds(value);
  memoryCacheSet(key, value, ttl);
  if (cacheEnabled) {
    try { await cacheSet(cacheKey(userId, key), JSON.stringify(value), ttl); } catch { /* memory cache still works */ }
  }
}

async function resolvePublisherUrl(originalUrl: string, domains: string[]): Promise<string | null> {
  const parsed = new URL(originalUrl);
  if (hostMatches(parsed.hostname, domains)) return originalUrl;
  if (![...REDIRECT_WRAPPERS].some((wrapper) => parsed.hostname === wrapper || parsed.hostname.endsWith('.' + wrapper))) return null;
  try {
    const response = await fetchUpstream(originalUrl, { headers: { Accept: 'text/html' }, timeoutMs: 5_000 });
    const finalUrl = response.url;
    await cancelBody(response);
    if (!finalUrl) return null;
    const final = new URL(finalUrl);
    return (final.protocol === 'http:' || final.protocol === 'https:') && hostMatches(final.hostname, domains)
      ? normalizeArticleUrl(finalUrl)
      : null;
  } catch { return null; }
}


const WELT_DOMAINS = ['welt.de'] as const;
const WELT_METADATA_MAX_BYTES = 1_500_000;
/** schema.org NewsArticle subtypes WELT emits per section (its debatte pieces are OpinionNewsArticle). */
const WELT_ARTICLE_TYPES = new Set<string>([
  'NewsArticle', 'OpinionNewsArticle', 'ReportageNewsArticle', 'BackgroundNewsArticle', 'Article',
]);

/** Match a WELT NewsArticle JSON-LD node to the requested article URL. */
function sameArticleUrl(candidate: unknown, requested: string): boolean {
  if (typeof candidate !== 'string') return false;
  try {
    const a = new URL(candidate);
    const b = new URL(requested);
    const hostA = a.hostname.toLowerCase().replace(/^www\./, '');
    const hostB = b.hostname.toLowerCase().replace(/^www\./, '');
    return (a.protocol === 'http:' || a.protocol === 'https:')
      && (b.protocol === 'http:' || b.protocol === 'https:')
      && hostA === hostB && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
  } catch { return false; }
}

/**
 * WELT exposes explicit per-article access metadata in its NewsArticle JSON-LD
 * (including the NewsArticle subtypes it uses, such as OpinionNewsArticle).
 * Only an exact matching article with isAccessibleForFree:false is eligible.
 * Missing/invalid metadata and free articles fail closed (open the publisher URL).
 */
export async function isWeltPremiumArticle(rawUrl: string): Promise<boolean> {
  let response: Response;
  try {
    response = await fetchUpstream(rawUrl, {
      headers: {
        Accept: 'text/html',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36',
      },
      timeoutMs: 7_000,
    });
  } catch { return false; }

  if (!response.ok || !(response.headers.get('content-type') || '').toLowerCase().includes('text/html')) {
    await cancelBody(response);
    return false;
  }
  // WELT pages can exceed this limit because of embedded page data. JSON-LD is in the head, so inspect a bounded prefix rather than rejecting the entire page when it is larger.
  const source = await readPrefixText(response, WELT_METADATA_MAX_BYTES, 5_000);
  if (source === null) return false;

  const scripts = source.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi);
  for (const match of scripts) {
    let parsed: unknown;
    try { parsed = JSON.parse(match[1]); } catch { continue; }
    const pending: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (pending.length) {
      const node = pending.pop();
      if (Array.isArray(node)) { pending.push(...node); continue; }
      if (!node || typeof node !== 'object') continue;
      const obj = node as Record<string, unknown>;
      if (obj['@graph']) pending.push(obj['@graph']);
      const types = Array.isArray(obj['@type']) ? obj['@type'] : [obj['@type']];
      if (types.some((type) => typeof type === 'string' && WELT_ARTICLE_TYPES.has(type))
        && sameArticleUrl(obj.url, rawUrl)) {
        return obj.isAccessibleForFree === false;
      }
    }
  }
  return false;
}

async function resolveForUser(userId: number, rawUrl: string, domains: string[]): Promise<ArchiveResolveResult> {
  const normalisedUrl = normalizeArticleUrl(rawUrl);
  if (!normalisedUrl) return { status: 'error' };
  const parsedOriginal = new URL(normalisedUrl);
  const isWelt = hostMatches(parsedOriginal.hostname, WELT_DOMAINS);
  if (!hostMatches(parsedOriginal.hostname, domains) && !isWelt
    && ![...REDIRECT_WRAPPERS].some((wrapper) => parsedOriginal.hostname === wrapper || parsedOriginal.hostname.endsWith('.' + wrapper))) {
    recordTrace({ requested: rawUrl, isWelt, duration_ms: 0 }, 'not_allowed');
    return { status: 'not_allowed' };
  }

  const safetyStartedAt = Date.now();
  try { await assertTargetSafe(normalisedUrl); }
  catch (error) {
    // DIAGNOSTIC (temporary): make the pre-pipeline guard failure observable.
    recordTrace({
      requested: rawUrl,
      isWelt,
      error: 'assertTargetSafe: ' + String((error as Error)?.message || error).slice(0, 300),
      duration_ms: Date.now() - safetyStartedAt,
    }, 'error');
    return { status: 'error' };
  }

  const key = `archive-resolve:${normalisedUrl}:${[...domains].sort().join(',')}`;
  const cached = await readCache(userId, key);
  if (cached) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;
  if (inFlight.size >= 64) return { status: 'error' };

  const work = (async (): Promise<ArchiveResolveResult> => {
    const trace: ResolveTrace = { requested: rawUrl, isWelt, duration_ms: 0 };
    const startedAt = Date.now();
    try {
      // WELT is special: archive only articles explicitly marked paywalled in
      // the matching NewsArticle JSON-LD. Free articles and unknown metadata
      // keep the normal direct-to-publisher behavior.
      if (isWelt) {
        const detectionStartedAt = Date.now();
        const premium = await isWeltPremiumArticle(normalisedUrl);
        trace.welt = { premium, ms: Date.now() - detectionStartedAt };
        if (!premium) {
          trace.duration_ms = Date.now() - startedAt;
          recordTrace(trace, 'not_allowed');
          return { status: 'not_allowed' };
        }
      }
      const effectiveDomains = isWelt ? [...domains, 'welt.de'] : domains;
      const publisherStartedAt = Date.now();
      const publisherUrl = await resolvePublisherUrl(normalisedUrl, effectiveDomains);
      trace.publisher = { result: publisherUrl || 'none', ms: Date.now() - publisherStartedAt };
      if (!publisherUrl) {
        trace.duration_ms = Date.now() - startedAt;
        recordTrace(trace, 'not_allowed');
        return { status: 'not_allowed' };
      }
    // The original target was already DNS-checked before this cache lookup.
    // Re-check only when a wrapper resolved to a different publisher URL.
    if (publisherUrl !== normalisedUrl) {
      try { await assertTargetSafe(publisherUrl); } catch { return { status: 'error' }; }
    }
    const publisher = new URL(publisherUrl);

    // All archive mirrors serve the same timemap; archive.is hangs from some
    // networks, so try mirrors in order instead of betting on one hostname.
    // A URL carrying share-tracking query parameters (wsj.com ?st=…&reflink=…,
    // washingtonpost.com ?linkNumber=…) 404s here although snapshots exist —
    // they are indexed under the bare URL — so retry without the query.
    const timemapHeaders = {
      Accept: 'application/link-format',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    };
    const lookupStartedAt = Date.now();
    let lookup = await fetchTimeMapWithFailover(publisherUrl, timemapHeaders);
    let lookupSource = 'url';
    if (!lookup && new URL(publisherUrl).search) {
      const bare = normalizeArticleUrl(new URL(publisherUrl).origin + new URL(publisherUrl).pathname);
      if (bare && bare !== publisherUrl) {
        lookup = await fetchTimeMapWithFailover(bare, timemapHeaders);
        lookupSource = 'bare';
      }
    }
    trace.timemapSource = lookupSource;
    if (!lookup) {
      trace.timemap = { httpStatus: null, contentType: null, count: 0, ms: Date.now() - lookupStartedAt };
      trace.duration_ms = Date.now() - startedAt;
      recordTrace(trace, 'soft_block');
      return { status: 'soft_block' };
    }
    const { response: lookupResponse } = lookup;
    const lookupStatus = lookupResponse.status;
    const lookupContentType = lookupResponse.headers.get('content-type');
    if (!lookupResponse.ok) {
      await cancelBody(lookupResponse);
      trace.timemap = { httpStatus: lookupStatus, contentType: lookupContentType, count: 0, ms: Date.now() - lookupStartedAt };
      trace.duration_ms = Date.now() - startedAt;
      recordTrace(trace, 'error');
      return { status: 'error' };
    }
    if (!(lookupContentType || '').toLowerCase().includes('application/link-format')) {
      await cancelBody(lookupResponse);
      trace.timemap = { httpStatus: lookupStatus, contentType: lookupContentType, count: 0, ms: Date.now() - lookupStartedAt };
      trace.duration_ms = Date.now() - startedAt;
      recordTrace(trace, 'soft_block');
      return { status: 'soft_block' };
    }
    const timeMap = await readLimitedText(lookupResponse, MAX_TIMEMAP_BYTES, TIMEMAP_BODY_TIMEOUT_MS);
    if (timeMap === null) {
      trace.timemap = { httpStatus: lookupStatus, contentType: lookupContentType, count: 0, ms: Date.now() - lookupStartedAt };
      trace.duration_ms = Date.now() - startedAt;
      recordTrace(trace, 'soft_block');
      return { status: 'soft_block' };
    }
    trace.timemap = { httpStatus: lookupStatus, contentType: lookupContentType, count: 0, ms: Date.now() - lookupStartedAt };
    const snapshots = parseTimeMap(timeMap).slice(0, 100);
    trace.timemap.count = snapshots.length;
    if (!snapshots.length) {
      trace.duration_ms = Date.now() - startedAt;
      recordTrace(trace, 'no_snapshot');
      return { status: 'no_snapshot' };
    }

    // Probe a small fixed number concurrently so one broken snapshot does not
    // leave the new tab blank for a long serial chain of timeouts. Preserve the
    // TimeMap's newest-first order when selecting the winner.
    trace.snapshots = [];
    const candidates = snapshots.slice(0, MAX_SNAPSHOT_CHECKS);
    const usable = await Promise.all(candidates.map((candidate) =>
      snapshotLooksUsable(candidate.url, publisher.hostname, trace)));
    const winner = candidates.find((candidate, index) => usable[index]);
    trace.winner = winner ? winner.url : null;
    const outcome = winner
      ? { status: 'ok' as const, url: winner.url, timestamp: winner.timestamp }
      : { status: 'no_good_snapshot' as const };
    trace.duration_ms = Date.now() - startedAt;
    recordTrace(trace, outcome.status);
    return outcome;
    } catch (error) {
      trace.error = String((error as Error)?.message || error).slice(0, 500);
      trace.duration_ms = Date.now() - startedAt;
      recordTrace(trace, 'error');
      return { status: 'error' };
    }
  })();

  inFlight.set(key, work);
  try {
    const result = await work;
    await writeCache(userId, key, result);
    return result;
  } finally {
    if (inFlight.get(key) === work) inFlight.delete(key);
  }
}

router.get('/debug', async (_req, res) => {
  // DIAGNOSTIC (temporary): recent resolver decision paths for failure triage.
  try {
    const rows = db.prepare(
      'SELECT id, at, requested_url, final_status, trace FROM archive_resolve_debug ORDER BY id DESC LIMIT 30',
    ).all();
    const parsed = rows.map((row) => {
      const r = row as { id: number; at: string; requested_url: string; final_status: string; trace: string };
      let trace: unknown = null;
      try { trace = JSON.parse(r.trace); } catch { trace = r.trace; }
      return { id: r.id, at: r.at, requested_url: r.requested_url, final_status: r.final_status, trace };
    });
    return res.json({ rows: parsed });
  } catch {
    return res.json({ rows: [] });
  }
});

router.get('/resolve', async (req, res) => {
  const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
  if (!rawUrl || rawUrl.length > 4096) return res.status(400).json({ status: 'error' });
  try {
    const result = await resolveForUser(req.user.id, rawUrl, savedDomains(req.user.id));
    return res.json(result);
  } catch {
    // Archive.is is optional; lookup failures must never break external opening.
    return res.json({ status: 'error' } satisfies ArchiveResolveResult);
  }
});

export default router;

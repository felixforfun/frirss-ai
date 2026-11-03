import { createHash } from 'node:crypto';
import db from './db.js';

// ═══════════════════════════════════════════════════════════════════════
// External discovery signals — provider registry, scheduler, persistence.
//
// Rework Phase 2: every provider sits behind the same registry interface
// (per-article lookup vs snapshot), one scheduler per provider with bounded
// concurrency, minimum spacing with jitter, in-flight deduplication and a
// circuit breaker. Evidence states are explicit: `measured` (real value in
// 0..1), `none` (provider answered, nothing applicable), `not-applicable`
// (e.g. no repository link), `unavailable` (error, throttled, breaker open).
// Failures never become negative measurements.
// ═══════════════════════════════════════════════════════════════════════

export type ExternalSource = 'gdelt' | 'github' | 'hackerNews' | 'lobsters' | 'wikipedia';
export type SignalState = 'measured' | 'none' | 'not-applicable' | 'unavailable';
export interface SignalValue {
  state: SignalState;
  /** Boost-space value in 0..1 when measured. */
  value?: number;
  /** When unavailable: suggested wait before asking again. */
  retryAfterMs?: number;
}
export interface ExternalArticleInput { url: string; title: string; summary: string; content: string; published?: number }

/** Per-request cohort context shared with lookups that need corpus statistics. */
export interface CohortContext {
  /** Normalized article titles of the whole request cohort (lowercased). */
  titles: string[];
  /** How many cohort articles contain each single token (for rarity guards). */
  tokenCounts: Map<string, number>;
}

// ── Persistence ────────────────────────────────────────────────────────

export const SIGNAL_CACHE_TABLE = `
  CREATE TABLE IF NOT EXISTS interesting_external_signal_cache (
    cache_key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    checked_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_interesting_external_signal_cache_checked
    ON interesting_external_signal_cache(checked_at);
`;

export const SIGNAL_FAILURES_TABLE = `
  CREATE TABLE IF NOT EXISTS signal_failures (
    provider TEXT NOT NULL,
    cache_key TEXT NOT NULL,
    failed_at INTEGER NOT NULL,
    backoff_until INTEGER NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (provider, cache_key)
  );
  CREATE INDEX IF NOT EXISTS idx_signal_failures_backoff ON signal_failures(backoff_until);
`;

export const SIGNAL_SNAPSHOTS_TABLE = `
  CREATE TABLE IF NOT EXISTS signal_snapshots (
    provider TEXT NOT NULL,
    scope TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (provider, scope, fetched_at)
  );
  CREATE INDEX IF NOT EXISTS idx_signal_snapshots_latest
    ON signal_snapshots(provider, scope, fetched_at);
`;

db.exec(SIGNAL_CACHE_TABLE + SIGNAL_FAILURES_TABLE + SIGNAL_SNAPSHOTS_TABLE);

// Retention cleanup at startup: cached evidence 30 days, failure accounting
// 30 days, raw snapshots 7 days.
db.prepare('DELETE FROM interesting_external_signal_cache WHERE checked_at < ?').run(Date.now() - 30 * 86400_000);
db.prepare('DELETE FROM signal_failures WHERE failed_at < ?').run(Date.now() - 30 * 86400_000);
db.prepare('DELETE FROM signal_snapshots WHERE fetched_at < ?').run(Date.now() - 7 * 86400_000);

export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.protocol = 'https:';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.pathname = url.pathname.replace(/\/$/, '') || '/';
    return url.toString();
  } catch {
    return raw.trim();
  }
}

export function cacheKey(source: ExternalSource, url: string): string {
  return source + ':' + createHash('sha256').update(canonicalUrl(url)).digest('hex');
}

// ── TTL policy (Phase 2.5) ─────────────────────────────────────────────

const MEASURED_TTL_MS: Record<ExternalSource, number> = {
  gdelt: 24 * 3600_000,
  github: 12 * 3600_000,
  hackerNews: 6 * 3600_000,
  lobsters: 6 * 3600_000,
  wikipedia: 24 * 3600_000,
};
const NONE_TTL_FRESH_MS = 2 * 3600_000;   // article younger than 24 h
const NONE_TTL_OLD_MS = 24 * 3600_000;
const NOT_APPLICABLE_TTL_MS = 24 * 3600_000;

/** TTL for one cached evidence value, given its source and the article's age. */
export function ttlForSignal(source: ExternalSource, signal: SignalValue, publishedMs: number | undefined): number {
  switch (signal.state) {
    case 'measured':
      return MEASURED_TTL_MS[source];
    case 'none': {
      const age = publishedMs !== undefined ? Date.now() - publishedMs : 48 * 3600_000;
      return age < 24 * 3600_000 ? NONE_TTL_FRESH_MS : NONE_TTL_OLD_MS;
    }
    case 'not-applicable':
      return NOT_APPLICABLE_TTL_MS;
    case 'unavailable':
      return 0;
  }
}

interface CacheRow { valueJson: string; checkedAt: number }

export function readSignalCache(source: ExternalSource, key: string): { hit: boolean; signal: SignalValue | null } {
  const row = db.prepare('SELECT value_json AS valueJson, checked_at AS checkedAt FROM interesting_external_signal_cache WHERE cache_key = ?')
    .get(key) as CacheRow | undefined;
  if (!row) return { hit: false, signal: null };
  let parsed: { state?: SignalState; value?: number } & Record<string, unknown>;
  try {
    parsed = JSON.parse(row.valueJson) as { state?: SignalState; value?: number };
  } catch {
    return { hit: false, signal: null };
  }
  // Legacy v1 rows carry {value: number|null} without a state.
  const signal: SignalValue = parsed.state
    ? { state: parsed.state, ...(parsed.value !== undefined ? { value: parsed.value } : {}) }
    : (parsed.value === null || parsed.value === undefined
      ? { state: 'unavailable' }
      : { state: 'measured', value: parsed.value });
  const ttl = ttlForSignal(source, signal, undefined);
  const fresh = Date.now() - row.checkedAt < ttl;
  if (!fresh) return { hit: true, signal: null }; // present but expired
  return { hit: true, signal };
}

export function writeSignalCache(key: string, signal: SignalValue): void {
  db.prepare(`INSERT INTO interesting_external_signal_cache (cache_key, value_json, checked_at)
    VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET value_json=excluded.value_json, checked_at=excluded.checked_at`)
    .run(key, JSON.stringify(signal), Date.now());
}

export function recordSignalFailure(provider: ExternalSource, key: string, reason: string, backoffUntil: number): void {
  db.prepare(`INSERT INTO signal_failures (provider, cache_key, failed_at, backoff_until, reason)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(provider, cache_key) DO UPDATE SET
      failed_at=excluded.failed_at, backoff_until=excluded.backoff_until, reason=excluded.reason`)
    .run(provider, key, Date.now(), backoffUntil, reason.slice(0, 500));
}

export function writeSnapshot(provider: ExternalSource, scope: string, payload: unknown, ttlMs: number, status = 'ok'): void {
  db.prepare(`INSERT INTO signal_snapshots (provider, scope, fetched_at, expires_at, status, payload_json)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, scope, fetched_at) DO UPDATE SET
      expires_at=excluded.expires_at, status=excluded.status, payload_json=excluded.payload_json`)
    .run(provider, scope, Date.now(), Date.now() + ttlMs, status, JSON.stringify(payload));
}

export function readLatestSnapshot<T>(provider: ExternalSource, scope: string): { payload: T; fetchedAt: number } | null {
  const row = db.prepare(`SELECT payload_json AS payloadJson, fetched_at AS fetchedAt FROM signal_snapshots
    WHERE provider = ? AND scope = ? ORDER BY fetched_at DESC LIMIT 1`).get(provider, scope) as
    { payloadJson: string; fetchedAt: number } | undefined;
  if (!row) return null;
  try {
    return { payload: JSON.parse(row.payloadJson) as T, fetchedAt: row.fetchedAt };
  } catch {
    return null;
  }
}

// ── Circuit breaker (Phase 2.3) ────────────────────────────────────────

export class Breaker {
  private openUntil = 0;
  private consecutiveFailures = 0;
  /** Cap on the exponential backoff (rework: doubling up to 30 minutes). */
  private static readonly MAX_BACKOFF_MS = 30 * 60_000;

  isOpen(now: number = Date.now()): boolean {
    return now < this.openUntil;
  }

  remainingMs(now: number = Date.now()): number {
    return Math.max(0, this.openUntil - now);
  }

  /** Trip on 429, on 403 with the rate limit exhausted, or on a malformed body. */
  trip(now: number, retryAfterMs?: number): void {
    this.consecutiveFailures++;
    const base = Math.max(retryAfterMs ?? 60_000, 60_000);
    const backoff = Math.min(base * 2 ** (this.consecutiveFailures - 1), Breaker.MAX_BACKOFF_MS);
    this.openUntil = Math.max(this.openUntil, now + backoff);
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openUntil = 0;
  }

  until(now: number = Date.now()): number {
    return this.isOpen(now) ? now + this.remainingMs(now) : 0;
  }
}

// ── Provider fetch with typed failures ─────────────────────────────────

export class SignalHttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfterMs?: number, public readonly rateLimitReset?: number) {
    super(message);
  }
}

export class SignalBodyError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const PROVIDER_UA = 'FriRSS-Interesting/1.0';

/**
 * Shared provider fetch: bounded timeout, JSON-only, typed failures the
 * scheduler's breaker understands. Non-JSON bodies trip the breaker (the
 * classic signature of a wall page or a proxy error).
 */
export async function fetchProviderJson<T>(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': PROVIDER_UA, ...(opts.headers ?? {}) },
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const retryAfterHeader = response.headers.get('retry-after');
    const retryAfterMs = retryAfterHeader ? (Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) * 1000 : Date.parse(retryAfterHeader) - Date.now() || undefined) : undefined;
    const rateLimitReset = Number(response.headers.get('x-ratelimit-reset')) || undefined;
    throw new SignalHttpError(response.status, 'External provider returned HTTP ' + response.status, retryAfterMs, rateLimitReset);
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SignalBodyError('External provider returned a non-JSON body');
  }
}

/** Classify one provider failure: breaker-trip, rate-limit, or transient. */
export function tripBreakerFor(breaker: Breaker, error: unknown, now: number = Date.now()): void {
  if (error instanceof SignalHttpError) {
    const rateLimitExhausted = error.status === 403 && error.rateLimitReset !== undefined;
    if (error.status === 429 || error.status === 403 || rateLimitExhausted) {
      const wait = error.rateLimitReset ? (error.rateLimitReset * 1000 - now) : error.retryAfterMs;
      breaker.trip(now, wait && wait > 0 ? wait : undefined);
      return;
    }
    return; // other HTTP statuses: transient, retry next request
  }
  if (error instanceof SignalBodyError) {
    breaker.trip(now);
    return;
  }
  // Network errors and aborts: transient.
}

// ── GITHUB_TOKEN (Phase 2.6) ───────────────────────────────────────────

/** Read once at startup; sent ONLY to api.github.com, never to other hosts. */
export const GITHUB_TOKEN = process.env.GITHUB_TOKEN?.trim() ?? '';

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (GITHUB_TOKEN) headers.Authorization = 'Bearer ' + GITHUB_TOKEN;
  return headers;
}

// ── Per-article provider lookups ───────────────────────────────────────

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function hostFromUrl(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function canonicalRepository(article: ExternalArticleInput): string | null {
  const text = [article.url, article.title, article.summary, article.content.slice(0, 12000)].join(' ');
  const matches = [...text.matchAll(/https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi)];
  for (const match of matches) {
    const owner = match[1];
    const repo = match[2].replace(/\.git$/i, '');
    if (!owner || !repo || ['issues', 'pull', 'pulls', 'tree', 'blob', 'commit', 'commits', 'settings', 'orgs', 'features', 'sponsors', 'topics'].includes(owner.toLowerCase())) continue;
    return owner + '/' + repo;
  }
  return null;
}

/** GitHub boost: unchanged 0..1 computation, keyed per owner/repo for caching. */
export async function githubLookup(article: ExternalArticleInput, breaker: Breaker): Promise<SignalValue> {
  const repository = canonicalRepository(article);
  if (!repository) return { state: 'not-applicable' }; // Not applicable is neutral, not a penalty.
  const data = await fetchProviderJson<{ stargazers_count?: number; pushed_at?: string; archived?: boolean }>(
    'https://api.github.com/repos/' + repository.split('/').map(encodeURIComponent).join('/'),
    { headers: githubHeaders() },
  );
  breaker.recordSuccess();
  const stars = Math.max(0, data.stargazers_count ?? 0);
  const popularity = Math.min(1, Math.log1p(stars) / Math.log1p(100000));
  const pushedAt = data.pushed_at ? Date.parse(data.pushed_at) : 0;
  const daysSincePush = pushedAt > 0 ? Math.max(0, (Date.now() - pushedAt) / 86400_000) : 3650;
  const activity = data.archived ? 0 : 1 / (1 + daysSincePush / 90);
  return { state: 'measured', value: clamp01(popularity * 0.65 + activity * 0.35) };
}

// GDELT language guard (Phase 2.7): German titles produce systematically poor
// queries, so only likely-English titles are looked up unless the owner's
// German-vs-English hit test showed parity (disable with
// GDELT_LANGUAGE_GUARD=off). The guard yields `unavailable` — neutral, never a
// penalty.
const GERMAN_TITLE_MARKERS = /\b(der|die|das|und|oder|ist|sind|war|wurde|nicht|auch|mit|für|ueber|über|nach|vor|beim|wird|werden|wurden|sagt|sagen|gegen|zwischen|durch|seit|mehr|als|aus|dem|den|des|eine|einen|einem|hat|haben|sich|ihre|sein|wieder|schon|noch|nur|wird)\b/gi;
const ENGLISH_TITLE_MARKERS = /\b(the|and|of|to|in|is|are|was|were|for|with|that|this|from|how|why|what|new|says|after|before|over|into|about|their|his|her|its|not|but|has|have|will|would|could)\b/gi;

export function isLikelyGermanTitle(title: string): boolean {
  const german = (title.match(GERMAN_TITLE_MARKERS) ?? []).length;
  const english = (title.match(ENGLISH_TITLE_MARKERS) ?? []).length;
  return german >= 2 && english === 0;
}

/** Language guard enabled by default; GDELT_LANGUAGE_GUARD=off disables it. */
export function gdeltLanguageGuardEnabled(): boolean {
  return (process.env.GDELT_LANGUAGE_GUARD ?? 'on').toLowerCase() !== 'off';
}

/** GDELT boost: unchanged breadth+volume computation. */
export async function gdeltLookup(article: ExternalArticleInput, breaker: Breaker): Promise<SignalValue> {
  if (gdeltLanguageGuardEnabled() && isLikelyGermanTitle(article.title)) {
    return { state: 'unavailable', retryAfterMs: 0 };
  }
  const stop = new Set([
    'the','and','for','with','from','that','this','into','about','after','before','over','under','how','why','what','when','where','who','are','was','were','has','have','will','its','new','says','said',
    'der','die','das','und','mit','fur','von','den','dem','des','ein','eine','einer','eines','einem','einen','ist','sind','nicht','auch','nach','vor','uber','unter','bei','aus','wie','was','wer','wird','werden','wurden','neue','neuen','laut','sagte',
    'les','des','une','pour','avec','dans','est','sont','aux','sur','par','qui','que','cette','ces','leur','leurs','mais','pas',
  ]);
  const terms = article.title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z0-9]{3,}/g)?.filter((term) => !stop.has(term)) ?? [];
  const queryTerms = [...new Set(terms)].slice(0, 6);
  if (queryTerms.length < 2) return { state: 'measured', value: 0 }; // nothing meaningful to ask: real zero
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86400_000);
  const stamp = (date: Date) => date.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const query = queryTerms.join(' ');
  const endpoint = 'https://api.gdeltproject.org/api/v2/doc/doc?' + new URLSearchParams({
    query, mode: 'artlist', maxrecords: '50', format: 'json', sort: 'HybridRel',
    startdatetime: stamp(start), enddatetime: stamp(end),
  }).toString();
  const data = await fetchProviderJson<{ articles?: Array<{ url?: string; domain?: string }> }>(endpoint);
  breaker.recordSuccess();
  const items = data.articles ?? [];
  const domains = new Set(items.map((item) => item.domain || hostFromUrl(item.url ?? '')).filter(Boolean));
  const breadth = Math.min(1, Math.log1p(domains.size) / Math.log1p(8));
  const volume = Math.min(1, Math.log1p(items.length) / Math.log1p(30));
  return { state: 'measured', value: clamp01(breadth * 0.7 + volume * 0.3) };
}

/** Hacker News boost: a hit is measured engagement; no hit is an honest none. */
export async function hackerNewsLookup(article: ExternalArticleInput, breaker: Breaker): Promise<SignalValue> {
  const endpoint = 'https://hn.algolia.com/api/v1/search?' + new URLSearchParams({
    query: canonicalUrl(article.url), tags: 'story', hitsPerPage: '10',
  }).toString();
  const data = await fetchProviderJson<{ hits?: Array<{ url?: string; points?: number; num_comments?: number; created_at_i?: number }> }>(endpoint);
  breaker.recordSuccess();
  const target = canonicalUrl(article.url);
  const hit = (data.hits ?? []).find((item) => item.url && canonicalUrl(item.url) === target);
  if (!hit) return { state: 'none' };
  const engagement = Math.min(1, Math.log1p(Math.max(0, hit.points ?? 0) + Math.max(0, hit.num_comments ?? 0) * 0.5) / Math.log1p(500));
  const ageDays = hit.created_at_i ? Math.max(0, (Date.now() / 1000 - hit.created_at_i) / 86400) : 30;
  return { state: 'measured', value: clamp01(engagement * (0.6 + 0.4 / (1 + ageDays / 14))) };
}

// ── Lobsters snapshot provider (Phase 2.8) ─────────────────────────────

export interface LobstersStory { url?: string; score?: number; comments_count?: number; created_at?: string }

/**
 * Snapshot refreshed every 15 minutes from the hottest page and the first
 * page of newest stories. The `page` parameter is part of the lobste.rs JSON
 * API; both fetches go through one snapshot write.
 */
export async function refreshLobstersSnapshot(breaker: Breaker): Promise<{ stories: LobstersStory[]; status: string }> {
  const hottest = await fetchProviderJson<LobstersStory[]>('https://lobste.rs/hottest.json?page=1');
  breaker.recordSuccess();
  const newest = await fetchProviderJson<LobstersStory[]>('https://lobste.rs/newest.json?page=1');
  breaker.recordSuccess();
  const byKey = new Map<string, LobstersStory>();
  for (const story of [...hottest, ...newest]) {
    const key = story.url ? canonicalUrl(story.url) : JSON.stringify(story).slice(0, 120);
    if (!byKey.has(key)) byKey.set(key, story);
  }
  const stories = [...byKey.values()];
  writeSnapshot('lobsters', 'frontpage', stories, 15 * 60_000);
  return { stories, status: 'ok' };
}

export function lobstersLookup(article: ExternalArticleInput): SignalValue {
  const snapshot = readLatestSnapshot<LobstersStory[]>('lobsters', 'frontpage');
  if (!snapshot) return { state: 'unavailable' };
  const target = canonicalUrl(article.url);
  const story = snapshot.payload.find((item) => item.url && canonicalUrl(item.url) === target);
  if (!story) return { state: 'none' };
  const engagement = Math.min(1, Math.log1p(Math.max(0, story.score ?? 0) + Math.max(0, story.comments_count ?? 0) * 0.5) / Math.log1p(200));
  const ageDays = story.created_at ? Math.max(0, (Date.now() - Date.parse(story.created_at)) / 86400_000) : 30;
  return { state: 'measured', value: clamp01(engagement * (0.6 + 0.4 / (1 + ageDays / 14))) };
}

/** Wikipedia matching lives in wikiPageviews.ts; the registry delegates. */
export type WikipediaMatcher = (article: ExternalArticleInput, context: CohortContext) => SignalValue;

// ── Provider registry + scheduler ──────────────────────────────────────

export interface ProviderSchedulerOptions {
  /** Maximum concurrent lookups. */
  concurrency: number;
  /** Minimum spacing between lookup starts, with ± jitterMs added. */
  minSpacingMs: number;
  jitterMs: number;
  /** Cap of live (queued + running) lookups; further jobs are rejected. */
  cycleBudget?: number;
}

/** The client request closed before the lookup started: drop it silently. */
export class CancelledLookupError extends Error {}

/** The provider's live-lookup budget is exhausted: stay pending, retry later. */
export class BudgetExceededError extends Error {}

export class ProviderScheduler {
  private queue: Array<{ key: string; priority: number; run: () => void; cancel: () => void }> = [];
  private running = 0;
  private nextStartAt = 0;
  private inflight = new Map<string, Promise<SignalValue>>();
  readonly breaker = new Breaker();

  constructor(readonly id: ExternalSource, private readonly options: ProviderSchedulerOptions) {}

  /**
   * Schedule one lookup, deduplicated by cache key. Priority: higher first
   * (recency; the personal rank is unavailable server-side). Throws
   * `BudgetExceededError` synchronously when the live-lookup cap is reached —
   * the caller keeps the url pending and a later poll retries.
   */
  schedule(key: string, priority: number, run: () => Promise<SignalValue>): Promise<SignalValue> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    if (this.options.cycleBudget && this.queue.length + this.running >= this.options.cycleBudget) {
      throw new BudgetExceededError('Provider budget exhausted for ' + this.id);
    }
    let resolveJob!: (signal: SignalValue) => void;
    let rejectJob!: (error: unknown) => void;
    const promise = new Promise<SignalValue>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    // Surface rejections through the caller's await only.
    void promise.catch(() => {});
    const entry = {
      key,
      priority,
      run: () => {
        Promise.resolve().then(run).then(resolveJob, rejectJob).finally(() => {
          this.inflight.delete(key);
          this.running--;
          this.pump();
        });
      },
      cancel: () => {
        this.inflight.delete(key);
        rejectJob(new CancelledLookupError('Request closed before the lookup started'));
      },
    };
    this.inflight.set(key, promise);
    this.queue.push(entry);
    this.pump();
    return promise;
  }

  /** Drop a queued (not yet started) job; returns true when it was queued. */
  cancel(key: string): boolean {
    const index = this.queue.findIndex((job) => job.key === key);
    if (index < 0) return false;
    const [job] = this.queue.splice(index, 1);
    job.cancel();
    return true;
  }

  hasInflight(key: string): boolean {
    return this.inflight.has(key);
  }

  private pump(): void {
    if (this.running >= this.options.concurrency || !this.queue.length) return;
    const now = Date.now();
    const startAt = Math.max(now, this.nextStartAt);
    const delay = startAt - now;
    setTimeout(() => {
      if (this.running >= this.options.concurrency || !this.queue.length) return;
      this.queue.sort((a, b) => b.priority - a.priority);
      const job = this.queue.shift();
      if (!job) return;
      this.running++;
      this.nextStartAt = Date.now() + this.options.minSpacingMs + (this.options.jitterMs ? Math.round((Math.random() * 2 - 1) * this.options.jitterMs) : 0);
      job.run();
      this.pump();
    }, delay);
  }

  /** Statistics for logging. */
  stats(): { queued: number; running: number } {
    return { queued: this.queue.length, running: this.running };
  }
}

/**
 * One scheduler per provider, with the rework's pacing: GDELT is demoted to a
 * global queue with 6 s spacing (± 1 s jitter) and at most 12 live lookups per
 * refresh cycle; GitHub, HN run concurrently.
 */
export const schedulers: Record<ExternalSource, ProviderScheduler> = {
  gdelt: new ProviderScheduler('gdelt', { concurrency: 1, minSpacingMs: 6000, jitterMs: 1000, cycleBudget: 12 }),
  github: new ProviderScheduler('github', { concurrency: 4, minSpacingMs: 0, jitterMs: 0 }),
  hackerNews: new ProviderScheduler('hackerNews', { concurrency: 6, minSpacingMs: 0, jitterMs: 0 }),
  lobsters: new ProviderScheduler('lobsters', { concurrency: 1, minSpacingMs: 0, jitterMs: 0 }),
  wikipedia: new ProviderScheduler('wikipedia', { concurrency: 1, minSpacingMs: 0, jitterMs: 0 }),
};

export function lookupFunctionFor(
  source: ExternalSource,
  wikipediaMatcher: WikipediaMatcher | null,
): (article: ExternalArticleInput, context: CohortContext) => Promise<SignalValue> {
  switch (source) {
    case 'gdelt':
      return async (article) => gdeltLookup(article, schedulers.gdelt.breaker);
    case 'github':
      return async (article) => githubLookup(article, schedulers.github.breaker);
    case 'hackerNews':
      return async (article) => hackerNewsLookup(article, schedulers.hackerNews.breaker);
    case 'lobsters':
      return async (article) => lobstersLookup(article);
    case 'wikipedia':
      if (!wikipediaMatcher) return async () => ({ state: 'unavailable' });
      return async (article, context) => wikipediaMatcher(article, context);
  }
}

/** Run one lookup through the scheduler + breaker + failure accounting. */
export async function runLookup(
  source: ExternalSource,
  key: string,
  article: ExternalArticleInput,
  priority: number,
  context: CohortContext,
  lookup: (article: ExternalArticleInput, context: CohortContext) => Promise<SignalValue>,
): Promise<SignalValue> {
  const scheduler = schedulers[source];
  const breaker = scheduler.breaker;
  if (breaker.isOpen()) {
    return { state: 'unavailable', retryAfterMs: breaker.remainingMs() };
  }
  try {
    return await scheduler.schedule(key, priority, () => lookup(article, context));
  } catch (error) {
    // A cancelled job and a budget rejection must stay invisible to the
    // failure accounting — neither is a provider failure.
    if (error instanceof CancelledLookupError || error instanceof BudgetExceededError) throw error;
    tripBreakerFor(breaker, error);
    const reason = error instanceof Error ? error.message : String(error);
    recordSignalFailure(source, key, reason, breaker.until());
    return { state: 'unavailable', ...(breaker.isOpen() ? { retryAfterMs: breaker.remainingMs() } : {}) };
  }
}

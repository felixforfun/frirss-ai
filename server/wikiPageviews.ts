import db from './db.js';
import type { SignalValue, ExternalArticleInput, CohortContext } from './externalSignals.js';

// ═══════════════════════════════════════════════════════════════════════
// Wikipedia pageview snapshot (rework Phase 5).
//
// Sourcing etiquette: the ingest polls the Wikimedia Pageviews REST API
// (wikimedia.org) sequentially, one project at a time, with spacing between
// requests, and identifies itself via WIKIMEDIA_CONTACT. 429 responses are
// honored (Retry-After) and the day is skipped until the next tick. Without
// WIKIMEDIA_CONTACT the ingest never starts — the signal then stays
// `unavailable` (neutral), never a penalty.
//
// Two tables, both additive:
//   wiki_top_daily  — the top-viewed articles per project per day
//                     (project, day, rank, article, views)
//   wiki_siteinfo   — the namespace names + mainpage title per project,
//                     refreshed weekly; static fallback while missing.
//
// Matching is EXACT TITLE ONLY (a listed title appears verbatim in the
// candidate's title, word-bounded, or in its summary with lower quality).
// No semantic matching, no redirects — the top-1000 lists are short enough
// that recall is capped by design and precision is what matters.
//
// Calibration constants below are documented judgment calls (rework §5
// Phase 5), to be revisited with data in Phase 6:
//   SPIKE_MIN ≥ 3            — pageview spike over the 7-day baseline
//   MIN_VIEWS per project    — floor for "notable enough to matter"
//   COHORT_TITLE_SHARE < 10% — a single-token title matching more than a
//                              tenth of the cohort is not a specific signal
// ═══════════════════════════════════════════════════════════════════════

export const WIKI_PROJECTS = ['de.wikipedia', 'en.wikipedia'] as const;
export type WikiProject = (typeof WIKI_PROJECTS)[number];
export const BACKFILL_DAYS = 14;
/** Days of history the spike baseline spans (list day + 7 previous days). */
export const BASELINE_DAYS = 7;
export const SPIKE_MIN = 3;
/** Documented judgment calls (Phase 6 will revisit with data). */
export const MIN_VIEWS: Record<WikiProject, number> = {
  'de.wikipedia': 20000,
  'en.wikipedia': 30000,
};

db.exec(`
  CREATE TABLE IF NOT EXISTS wiki_top_daily (
    project TEXT NOT NULL,
    day     TEXT NOT NULL,
    rank    INTEGER NOT NULL,
    article TEXT NOT NULL,
    views   INTEGER NOT NULL,
    PRIMARY KEY (project, day, article)
  );
  CREATE INDEX IF NOT EXISTS idx_wiki_top_daily_day ON wiki_top_daily(project, day);
  CREATE TABLE IF NOT EXISTS wiki_siteinfo (
    project     TEXT PRIMARY KEY,
    mainpage    TEXT NOT NULL,
    namespaces_json TEXT NOT NULL,
    fetched_at  INTEGER NOT NULL
  );
`);

/** Wikimedia etiquette: contact identity required, baked into the UA. */
export function wikimediaContact(): string {
  return process.env.WIKIMEDIA_CONTACT?.trim() ?? '';
}

function userAgent(): string {
  const contact = wikimediaContact();
  return 'FriRSS/1.0 (https://github.com/felixforfun/frirss-ai' + (contact ? '; ' + contact : '') + ')';
}

// ── Siteinfo (namespaces + mainpage), weekly, static fallback ──────────

interface SiteinfoState { mainpage: string; namespaces: string[]; fetchedAt: number }

/** Non-namespace prefixes that appear in top lists but are never stories. */
const STATIC_NAMESPACES: Record<WikiProject, string[]> = {
  'de.wikipedia': ['Wikipedia', 'Datei', 'Hilfe', 'Kategorie', 'Portal', 'Vorlage', 'Spezial',
    'Diskussion', 'Wikipedia Diskussion', 'Datei Diskussion', 'Hilfe Diskussion', 'Kategorie Diskussion',
    'Portal Diskussion', 'Vorlage Diskussion', 'Benutzer', 'Benutzer Diskussion', 'Entwurf', 'Modul',
    'MediaWiki', 'Medium', 'Thema', 'Liste'],
  'en.wikipedia': ['Wikipedia', 'File', 'Help', 'Category', 'Portal', 'Template', 'Special',
    'Talk', 'Wikipedia talk', 'File talk', 'Help talk', 'Category talk', 'Portal talk',
    'Template talk', 'User', 'User talk', 'Draft', 'Module', 'MediaWiki', 'Media', 'Book',
    'Education Program', 'Course', 'Topic', 'Gadget', 'Gadget definition', 'TimedText', 'List'],
};

export function readSiteinfo(project: WikiProject): SiteinfoState {
  const fallback: SiteinfoState = {
    mainpage: project === 'de.wikipedia' ? 'Wikipedia:Hauptseite' : 'Main Page',
    namespaces: STATIC_NAMESPACES[project],
    fetchedAt: 0,
  };
  const row = db.prepare('SELECT mainpage, namespaces_json AS namespacesJson, fetched_at AS fetchedAt FROM wiki_siteinfo WHERE project = ?')
    .get(project) as { mainpage: string; namespacesJson: string; fetchedAt: number } | undefined;
  if (!row) return fallback;
  try {
    return { mainpage: row.mainpage, namespaces: JSON.parse(row.namespacesJson) as string[], fetchedAt: row.fetchedAt };
  } catch {
    return fallback;
  }
}

async function refreshSiteinfo(project: WikiProject, now: number): Promise<void> {
  const existing = readSiteinfo(project);
  if (now - existing.fetchedAt < 7 * 86400_000) return;
  try {
    const url = 'https://' + project + '.org/w/api.php?' + new URLSearchParams({
      action: 'query', meta: 'siteinfo', siprop: 'general|namespaces', format: 'json', formatversion: '2',
    }).toString();
    const response = await fetchWikimediaJson<{
      query?: {
        general?: { mainpage?: string };
        namespaces?: Record<string, { id?: number; name?: string; canonical?: string; aliases?: Array<{ alias?: string }> }>;
      };
    }>(url);
    // fetchWikimediaJson returns a wrapper { data, retryAfterMs, status } —
    // the query payload lives under response.data, not on the wrapper itself.
    const data = response.data;
    const namespaces = new Set<string>();
    for (const [id, namespace] of Object.entries(data.query?.namespaces ?? {})) {
      // Namespace 0 is the article space; negative ids are virtual namespaces.
      if (Number(id) <= 0) continue;
      for (const name of [namespace.name, namespace.canonical, ...(namespace.aliases ?? []).map((alias) => alias.alias ?? '')]) {
        if (name) namespaces.add(name);
      }
    }
    const state: SiteinfoState = {
      mainpage: data.query?.general?.mainpage || existing.mainpage,
      namespaces: namespaces.size ? [...namespaces] : existing.namespaces,
      fetchedAt: now,
    };
    db.prepare(`INSERT INTO wiki_siteinfo (project, mainpage, namespaces_json, fetched_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(project) DO UPDATE SET
      mainpage=excluded.mainpage, namespaces_json=excluded.namespaces_json, fetched_at=excluded.fetched_at`)
      .run(project, state.mainpage, JSON.stringify(state.namespaces), now);
  } catch {
    // Siteinfo is an optimization; the static fallback covers matching.
  }
}

// ── Daily top lists ────────────────────────────────────────────────────

export interface WikiTopRow { project: string; day: string; rank: number; article: string; views: number }

function dayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The most recent stored day for a project, or '' when none. */
export function latestStoredDay(project: WikiProject): string {
  const row = db.prepare('SELECT MAX(day) AS day FROM wiki_top_daily WHERE project = ?').get(project) as { day: string | null };
  return row.day ?? '';
}

async function fetchWikimediaJson<T>(url: string, timeoutMs = 20000): Promise<{ data: T; retryAfterMs?: number; status: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': userAgent() } });
    if (!response.ok) {
      const retryAfter = response.headers.get('retry-after');
      const retryAfterMs = retryAfter ? Number(retryAfter) * 1000 : undefined;
      return { data: undefined as T, retryAfterMs, status: response.status };
    }
    return { data: await response.json() as T, status: 200 };
  } finally {
    clearTimeout(timeout);
  }
}

/** Fetch and store the top list for one (project, day). Returns true when stored. */
export async function ingestWikiDay(project: WikiProject, day: string): Promise<boolean> {
  const stamp = day.replaceAll('-', '/');
  const url = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/top/' + project + '/all-access/' + stamp;
  const response = await fetchWikimediaJson<{ items?: Array<{ articles?: Array<{ article: string; views: number; rank: number }> }> }>(url);
  if (response.status !== 200 || !response.data) return false; // 429/404: skip, next tick retries
  const articles = response.data.items?.[0]?.articles ?? [];
  const insert = db.prepare(`INSERT INTO wiki_top_daily (project, day, rank, article, views)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(project, day, article) DO UPDATE SET
    rank=excluded.rank, views=excluded.views`);
  const writeMany = db.transaction((rows: WikiTopRow[]) => {
    for (const row of rows) insert.run(row.project, row.day, row.rank, row.article, row.views);
  });
  writeMany(articles.map((item) => ({ project, day, rank: item.rank, article: item.article, views: item.views })));
  return true;
}

/** Is a listed title a namespace page (never a story)? */
export function isExcludedTitle(project: WikiProject, rawTitle: string, siteinfo: SiteinfoState): boolean {
  const title = rawTitle.replaceAll('_', ' ').trim();
  if (title.toLowerCase() === siteinfo.mainpage.toLowerCase()) return true;
  const colon = title.indexOf(':');
  if (colon <= 0) return false;
  const prefix = title.slice(0, colon).trim().toLowerCase();
  return siteinfo.namespaces.some((namespace) => namespace.toLowerCase() === prefix);
}

// ── Ingest loop ────────────────────────────────────────────────────────

let ingestRunning = false;
let ingestTimer: ReturnType<typeof setInterval> | null = null;
/** Spacing between Wikimedia requests (etiquette); overridable for tests. */
let spacingMs = 30_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One ingest pass: refresh siteinfo weekly, then fetch every missing day of
 * the last BACKFILL_DAYS per project, newest first, spaced out. Failures and
 * 429s skip a day; the hourly tick retries. A run must never overlap itself.
 */
export async function runIngestPass(now: number = Date.now()): Promise<void> {
  if (ingestRunning) return;
  if (!wikimediaContact()) return; // never contacted Wikimedia without identity
  ingestRunning = true;
  try {
    for (const project of WIKI_PROJECTS) {
      await refreshSiteinfo(project, now);
      const latest = latestStoredDay(project);
      const cutoff = new Date(now - BACKFILL_DAYS * 86400_000);
      // Pageview data lags 1–2 days: start at yesterday, walk back to cutoff.
      for (let offset = 1; offset <= BACKFILL_DAYS; offset++) {
        const day = dayString(new Date(now - offset * 86400_000));
        if (latest && day <= latest) break; // everything older is already stored
        const exists = db.prepare('SELECT 1 FROM wiki_top_daily WHERE project = ? AND day = ? LIMIT 1')
          .get(project, day);
        if (exists) continue;
        const stored = await ingestWikiDay(project, day);
        if (!stored) break; // rate limited or day not published yet: retry next tick
        await wait(spacingMs);
      }
    }
  } finally {
    ingestRunning = false;
  }
}

export function startWikiIngest(): void {
  if (ingestTimer) return;
  if (!wikimediaContact()) {
    console.warn('[wikipedia] WIKIMEDIA_CONTACT is not set; the Wikipedia signal stays unavailable.');
    return;
  }
  void runIngestPass();
  ingestTimer = setInterval(() => { void runIngestPass(); }, 3600_000);
  ingestTimer.unref?.();
}

export function stopWikiIngest(): void {
  if (ingestTimer) clearInterval(ingestTimer);
  ingestTimer = null;
}

/** Test hook: override the inter-request spacing. */
export function setIngestSpacing(ms: number): void {
  spacingMs = ms;
}

// ── Matching ───────────────────────────────────────────────────────────

export function normalizeWikiTitle(title: string): string {
  return title.replaceAll('_', ' ').replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whole-word containment, tolerant of Unicode word characters. */
function containsPhrase(haystack: string, phrase: string): boolean {
  if (!phrase) return false;
  if (phrase.length <= 2) return false;
  const escaped = escapeRegExp(phrase);
  return new RegExp('(^|[^\\p{L}\\p{N}])' + escaped + '([^\\p{L}\\p{N}]|$)', 'iu').test(haystack);
}

interface MatchCandidate { title: string; quality: number }

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

let listCache: { expiresAt: number; rows: WikiTopRow[] } | null = null;

/** Test hook: clear the brief request-path list cache. */
export function resetListCache(): void {
  listCache = null;
}

/** Recent rows (BASELINE_DAYS + today), cached briefly for the request path. */
function loadRecentRows(now: number): WikiTopRow[] {
  if (listCache && listCache.expiresAt > now) return listCache.rows;
  const rows = db.prepare(`SELECT project, day, rank, article, views FROM wiki_top_daily
    WHERE day > ? ORDER BY day DESC, rank ASC`)
    .all(dayString(new Date(now - (BASELINE_DAYS + 1) * 86400_000))) as WikiTopRow[];
  listCache = { expiresAt: now + 5 * 60_000, rows };
  return rows;
}

/**
 * Exact-title matching with the documented guards. Returns a measured boost
 * when a listed page matches, `none` when the lists were checked and nothing
 * applies, `unavailable` when no lists have been ingested yet (neutral).
 */
export function wikipediaMatcher(article: ExternalArticleInput, context: CohortContext): SignalValue {
  const now = Date.now();
  const rows = loadRecentRows(now);
  if (!rows.length) return { state: 'unavailable' }; // ingest not finished yet

  const siteinfoByProject = new Map(WIKI_PROJECTS.map((project) => [project, readSiteinfo(project)]));
  const titleLower = article.title.toLowerCase();
  const summaryLower = article.summary.toLowerCase();

  // Candidate (project, listed title) pairs that match the article at all.
  const candidates: Array<{ project: WikiProject; title: string; quality: number }> = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const project = row.project as WikiProject;
    if (!WIKI_PROJECTS.includes(project)) continue;
    const dedupeKey = project + '|' + row.article;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (isExcludedTitle(project, row.article, siteinfoByProject.get(project)!)) continue;
    const phrase = normalizeWikiTitle(row.article);
    // Guard: a single-token title must be reasonably specific, both in
    // wording length and in how much of the cohort it would match.
    const tokens = phrase.split(WORD_SPLIT).filter(Boolean);
    if (tokens.length === 1 && phrase.length < 5) continue;
    if (tokens.length <= 1) {
      const cohortHits = context.titles.filter((title) => title.includes(phrase)).length;
      if (context.titles.length > 0 && cohortHits / context.titles.length >= 0.10) continue;
    }
    let quality = 0;
    if (containsPhrase(titleLower, phrase)) quality = 1;
    else if (containsPhrase(summaryLower, phrase)) quality = 0.6;
    if (!quality) continue;
    candidates.push({ project, title: row.article, quality });
  }
  if (!candidates.length) return { state: 'none' };

  // Score each candidate from its day-by-day view history.
  let best = 0;
  for (const candidate of candidates) {
    const siteinfo = siteinfoByProject.get(candidate.project)!;
    if (isExcludedTitle(candidate.project, candidate.title, siteinfo)) continue;
    const minViews = MIN_VIEWS[candidate.project];
    const dayRows = new Map<string, number>();
    for (const row of rows) {
      if (row.project !== candidate.project || row.article !== candidate.title) continue;
      dayRows.set(row.day, row.views);
    }
    const days = [...dayRows.keys()].sort();
    const peakDay = days[days.length - 1];
    if (!peakDay) continue;
    const peakViews = dayRows.get(peakDay)!;
    if (peakViews < minViews) continue;
    const baselineValues = days.filter((day) => day < peakDay).map((day) => dayRows.get(day)!);
    const baseline = Math.max(median(baselineValues), minViews * 0.5);
    const spike = peakViews / baseline;
    if (spike < SPIKE_MIN) continue;
    const daysOld = Math.max(0, (now - Date.parse(peakDay + 'T12:00:00Z')) / 86400_000);
    const decay = 0.5 ** Math.max(0, daysOld - 1);
    const boost = Math.max(0, Math.min(1, Math.log(spike) / Math.log(10))) * candidate.quality * decay;
    if (boost > best) best = boost;
  }
  if (best <= 0) return { state: 'none' };
  return { state: 'measured', value: best };
}

/** Builds the cohort context the route passes to every matcher. */
export function buildCohortContext(articles: ExternalArticleInput[]): CohortContext {
  const titles: string[] = [];
  const tokenCounts = new Map<string, number>();
  for (const article of articles) {
    const title = article.title.toLowerCase();
    titles.push(title);
    for (const token of title.split(WORD_SPLIT)) {
      if (!token) continue;
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }
  return { titles, tokenCounts };
}

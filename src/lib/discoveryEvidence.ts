import type { Article } from '../types';
import type { ExternalSignalSource, ExternalEvidence, ExternalEvidenceByUrl } from './intelligenceRanking';

// ═══════════════════════════════════════════════════════════════════════
// Discovery acquisition policy (pure functions, no React, no network).
//
// Layer A of the rework: what to fetch, what to keep, what is stale.
// Ranking (Layer B) consumes the resulting evidence map; these helpers never
// clear, refetch on slider moves, or mix the two layers.
// ═══════════════════════════════════════════════════════════════════════

/** Cohort identity: the sorted, hashed set of candidate URLs. */
export function cohortKey(articles: Article[]): string {
  const urls = articles.map((article) => article.url).sort();
  return `${urls.length}:${hashString(urls.join('\u001e'))}`;
}

function hashString(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Stable acquisition key: algorithm, cohort, sorted active sources. Weight changes that do not cross zero never refetch. */
export function acquisitionKey(algorithm: string, cohort: string, sources: ExternalSignalSource[]): string {
  return [algorithm, cohort, [...sources].sort().join('+')].join('|');
}

/**
 * Client-side freshness, mirroring the server TTL policy (rework §5 Phase 2.5).
 * A measured consensus value reflects a changing cohort and is revalidated
 * sooner than a stable GitHub repository score.
 */
const MEASURED_TTL_MS: Record<ExternalSignalSource, number> = {
  gdelt: 24 * 3600_000,
  github: 12 * 3600_000,
  hackerNews: 6 * 3600_000,
  lobsters: 6 * 3600_000,
  consensus: 15 * 60_000,
  wikipedia: 24 * 3600_000,
  googleTrends: 2 * 3600_000,
};

/** "Provider answered, nothing applicable" ages quickly for fresh articles (they may gain traction), slowly for old ones. */
const NONE_TTL_FRESH_MS = 2 * 3600_000;
const NONE_TTL_OLD_MS = 24 * 3600_000;

/** Internal evidence slot: state plus which source it belongs to and when it arrived, so freshness is computable client-side. */
export interface TimedEvidence extends ExternalEvidence {
  source: ExternalSignalSource;
  fetchedAt: number;
}
export type TimedEvidenceByUrl = Record<string, Partial<Record<ExternalSignalSource, TimedEvidence>>>;

/** Attach arrival time to a server response's state entries. */
export function timedEvidenceFromStates(
  states: Record<string, Partial<Record<ExternalSignalSource, ExternalEvidence>>>,
  fetchedAt: number,
): TimedEvidenceByUrl {
  const timed: TimedEvidenceByUrl = {};
  for (const [url, slots] of Object.entries(states)) {
    const converted: Partial<Record<ExternalSignalSource, TimedEvidence>> = {};
    for (const [source, evidence] of Object.entries(slots) as Array<[ExternalSignalSource, ExternalEvidence]>) {
      if (!evidence) continue;
      converted[source] = { ...evidence, source, fetchedAt };
    }
    timed[url] = converted;
  }
  return timed;
}

export function isEvidenceFresh(evidence: TimedEvidence | undefined, now: number, publishedAt: number): boolean {
  if (!evidence) return false;
  const age = now - evidence.fetchedAt;
  switch (evidence.state) {
    case 'measured':
      return age < MEASURED_TTL_MS[evidence.source];
    case 'none': {
      const articleAge = now - publishedAt;
      return age < (articleAge < 24 * 3600_000 ? NONE_TTL_FRESH_MS : NONE_TTL_OLD_MS);
    }
    case 'not-applicable':
      return age < 24 * 3600_000;
    case 'unavailable':
      return false;
  }
}

/**
 * Merge policy. Existing `measured` evidence is never downgraded by an
 * `unavailable` response while it is still fresh (an outage must not erase a
 * measurement); everything else replaces the previous slot.
 */
export function mergeEvidence(
  current: TimedEvidenceByUrl,
  incoming: TimedEvidenceByUrl,
  now: number,
  publishedByUrl: Map<string, number>,
): TimedEvidenceByUrl {
  const merged: TimedEvidenceByUrl = { ...current };
  for (const [url, slots] of Object.entries(incoming)) {
    const existing = merged[url] ?? {};
    const next = { ...existing };
    for (const [source, evidence] of Object.entries(slots) as Array<[ExternalSignalSource, TimedEvidence]>) {
      const previous = existing[source];
      const stillFresh = previous && isEvidenceFresh(previous, now, publishedByUrl.get(url) ?? now);
      if (previous?.state === 'measured' && evidence.state === 'unavailable' && stillFresh) continue;
      next[source] = evidence;
    }
    merged[url] = next;
  }
  return merged;
}

/**
 * The (article, source) pairs the acquisition should request now: pairs with
 * no evidence, stale evidence, or an `unavailable` state past its retry hint.
 */
export function missingPairs(
  articles: Article[],
  sources: ExternalSignalSource[],
  evidence: TimedEvidenceByUrl,
  now: number,
): Article[] {
  const missing = new Set<string>();
  const result: Article[] = [];
  for (const article of articles) {
    const slots = evidence[article.url];
    const needed = sources.some((source) => !isEvidenceFresh(slots?.[source], now, article.published));
    if (!needed || missing.has(article.url)) continue;
    missing.add(article.url);
    result.push(article);
  }
  return result;
}

/** Per-source coverage counts for the preferences UI: measured evidence over requested candidates. */
export function coverageCounts(
  articles: Article[],
  sources: ExternalSignalSource[],
  evidence: TimedEvidenceByUrl,
): { measured: Partial<Record<ExternalSignalSource, number>>; candidates: number } {
  const measured: Partial<Record<ExternalSignalSource, number>> = {};
  for (const source of sources) measured[source] = 0;
  for (const article of articles) {
    const slots = evidence[article.url];
    if (!slots) continue;
    for (const source of sources) {
      if (slots[source]?.state === 'measured') measured[source] = (measured[source] ?? 0) + 1;
    }
  }
  return { measured, candidates: articles.length };
}

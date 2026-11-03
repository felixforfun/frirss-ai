import { describe, expect, it } from 'vitest';
import type { Article } from '../types';
import type { ExternalSignalSource } from './intelligenceRanking';
import {
  acquisitionKey,
  cohortKey,
  coverageCounts,
  isEvidenceFresh,
  mergeEvidence,
  missingPairs,
  timedEvidenceFromStates,
  type TimedEvidence,
} from './discoveryEvidence';

const NOW = Date.parse('2026-06-01T12:00:00Z');

function article(id: string, published = NOW - 3_600_000): Article {
  return {
    id, title: `Title ${id}`, summary: `Summary ${id}`, content: '', author: '',
    url: `https://example.test/${id}`, source: 'Example', sourceId: 'feed/1',
    published, read: false, starred: false, labels: [], tags: [],
  };
}

function slot(state: TimedEvidence['state'], fetchedAgo = 0, value?: number): TimedEvidence {
  return { state, source: 'consensus', fetchedAt: NOW - fetchedAgo, ...(value !== undefined ? { value } : {}) };
}

describe('cohort and acquisition keys', () => {
  it('the cohort key depends on the URL set only, not on order or content', () => {
    const first = [article('a'), article('b')];
    const reordered = [article('b'), article('a')];
    const changedText = [{ ...article('a'), title: 'Rewritten' }, article('b')];
    expect(cohortKey(first)).toBe(cohortKey(reordered));
    expect(cohortKey(first)).toBe(cohortKey(changedText));
    expect(cohortKey(first)).not.toBe(cohortKey([article('a'), article('b'), article('c')]));
  });

  it('the acquisition key changes only when something material changes', () => {
    const sources: ExternalSignalSource[] = ['consensus', 'github'];
    expect(acquisitionKey('custom', 'cohort', sources)).toBe(acquisitionKey('custom', 'cohort', ['github', 'consensus']));
    expect(acquisitionKey('custom', 'cohort', sources)).not.toBe(acquisitionKey('custom', 'cohort', ['consensus']));
    expect(acquisitionKey('custom', 'cohort', sources)).not.toBe(acquisitionKey('custom', 'other', sources));
  });
});

describe('evidence freshness', () => {
  it('measured evidence respects the per-source TTL', () => {
    // HN measured 6 h, GDELT measured 24 h.
    const hn = { ...slot('measured', 5 * 3600_000), source: 'hackerNews' as const };
    const gdelt = { ...slot('measured', 20 * 3600_000), source: 'gdelt' as const };
    expect(isEvidenceFresh(hn, NOW, NOW - 3600_000)).toBe(true);
    expect(isEvidenceFresh({ ...hn, fetchedAt: NOW - 7 * 3600_000 }, NOW, NOW - 3600_000)).toBe(false);
    expect(isEvidenceFresh(gdelt, NOW, NOW - 3600_000)).toBe(true);
    expect(isEvidenceFresh({ ...gdelt, fetchedAt: NOW - 25 * 3600_000 }, NOW, NOW - 3600_000)).toBe(false);
  });

  it('none-state ages quickly for fresh articles and slowly for old ones', () => {
    const freshArticle = NOW - 3_600_000;
    const oldArticle = NOW - 48 * 3600_000;
    const none2h = slot('none', 1.5 * 3600_000);
    expect(isEvidenceFresh(none2h, NOW, freshArticle)).toBe(true);
    expect(isEvidenceFresh(slot('none', 3 * 3600_000), NOW, freshArticle)).toBe(false);
    expect(isEvidenceFresh(slot('none', 3 * 3600_000), NOW, oldArticle)).toBe(true);
    expect(isEvidenceFresh(slot('none', 25 * 3600_000), NOW, oldArticle)).toBe(false);
  });

  it('unavailable is never fresh; not-applicable lasts a day', () => {
    expect(isEvidenceFresh(slot('unavailable'), NOW, NOW)).toBe(false);
    expect(isEvidenceFresh(slot('not-applicable', 23 * 3600_000), NOW, NOW)).toBe(true);
    expect(isEvidenceFresh(slot('not-applicable', 25 * 3600_000), NOW, NOW)).toBe(false);
  });
});

describe('merge policy', () => {
  it('an unavailable response never erases a fresh measured value', () => {
    const publishedByUrl = new Map([['https://example.test/a', NOW - 3600_000]]);
    const current = { 'https://example.test/a': { consensus: slot('measured', 60_000, 0.7) } };
    const incoming = timedEvidenceFromStates({ 'https://example.test/a': { consensus: { state: 'unavailable' } } }, NOW);
    const merged = mergeEvidence(current, incoming, NOW, publishedByUrl);
    expect(merged['https://example.test/a'].consensus).toMatchObject({ state: 'measured', value: 0.7 });
  });

  it('an expired measured value is replaced by the unavailable response', () => {
    const publishedByUrl = new Map([['https://example.test/a', NOW - 3600_000]]);
    const current = { 'https://example.test/a': { consensus: { ...slot('measured', 30 * 3600_000), source: 'consensus' as const, value: 0.7 } } };
    const incoming = timedEvidenceFromStates({ 'https://example.test/a': { consensus: { state: 'unavailable' } } }, NOW);
    const merged = mergeEvidence(current, incoming, NOW, publishedByUrl);
    expect(merged['https://example.test/a'].consensus).toMatchObject({ state: 'unavailable' });
  });

  it('a measured value replaces a previous none', () => {
    const publishedByUrl = new Map([['https://example.test/a', NOW - 3600_000]]);
    const current = { 'https://example.test/a': { consensus: slot('none', 3600_000) } };
    const incoming = timedEvidenceFromStates({ 'https://example.test/a': { consensus: { state: 'measured', value: 0.4 } } }, NOW);
    const merged = mergeEvidence(current, incoming, NOW, publishedByUrl);
    expect(merged['https://example.test/a'].consensus).toMatchObject({ state: 'measured', value: 0.4 });
  });
});

describe('missing pairs', () => {
  it('requests only articles lacking fresh evidence for any active source', () => {
    const a = article('a');
    const b = article('b');
    const c = article('c');
    const evidence = {
      // a: fresh consensus, missing github → needs a request (github active)
      'https://example.test/a': { consensus: slot('measured', 60_000) },
      // b: everything fresh → no request
      'https://example.test/b': { consensus: slot('measured', 60_000), github: { ...slot('measured', 60_000), source: 'github' as const } },
      // c: stale measured → request
      'https://example.test/c': { consensus: { ...slot('measured', 30 * 3600_000), source: 'consensus' as const } },
    };
    const missing = missingPairs([a, b, c], ['consensus', 'github'], evidence, NOW);
    expect(missing.map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('articles are requested once even when several sources are missing', () => {
    const a = article('a');
    const missing = missingPairs([a], ['consensus', 'github', 'hackerNews'], {}, NOW);
    expect(missing).toHaveLength(1);
  });
});

describe('coverage counts', () => {
  it('counts measured slots per source over the requested candidates', () => {
    const articles = [article('a'), article('b'), article('c')];
    const evidence = {
      'https://example.test/a': { consensus: slot('measured', 0, 0.5), github: { ...slot('none', 0), source: 'github' as const } },
      'https://example.test/b': { consensus: slot('unavailable', 0) },
    };
    const counts = coverageCounts(articles, ['consensus', 'github'], evidence);
    expect(counts.measured.consensus).toBe(1);
    expect(counts.measured.github).toBe(0);
    expect(counts.candidates).toBe(3);
  });
});

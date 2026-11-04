import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mocks must be declared before importing consensus.js.
vi.mock('./semanticEmbeddings.js', () => ({
  resolveEmbeddingProvider: vi.fn(),
}));

vi.mock('./semanticEmbeddingService.js', () => ({
  semanticEmbeddingsFor: vi.fn(),
}));

import db from './db.js';
import {
  TAU_STORY,
  TAU_DUP,
  detectWireMarker,
  clusterByAverageLinkage,
  computeOrigins,
  consensusBoost,
  computeCoverage,
  resetCoverageCache,
  COVERAGE_WINDOW_MS,
  type ConsensusArticle,
} from './consensus.js';
import { resolveEmbeddingProvider } from './semanticEmbeddings.js';
import { semanticEmbeddingsFor } from './semanticEmbeddingService.js';
import { embeddingCacheKey, embeddingText } from './semanticScoring.js';

// ── test doubles for the embedding pipeline ─────────────────────────────

const model = 'bge-m3';

function provider(id: 'openrouter' | 'ollama' = 'openrouter') {
  return {
    id,
    model,
    // The tests mock semanticEmbeddingsFor, so embed() is never reached —
    // the stub just satisfies the EmbeddingProvider contract.
    embed: async (): Promise<number[][]> => {
      throw new Error('provider.embed should not be called in coverage tests');
    },
  };
}

type MockEmbedJob = { text: string; key: string };

/** Mock semanticEmbeddingsFor: return a unit-ish vector per known job key. */
function stubEmbeddings(vectorsByKey: Record<string, number[]>) {
  vi.mocked(semanticEmbeddingsFor).mockImplementation(async (_provider, jobs: MockEmbedJob[]) => ({
    vectors: jobs
      .filter((job) => vectorsByKey[job.key] !== undefined)
      .map((job) => ({ key: job.key, vector: vectorsByKey[job.key] })),
    notAttempted: new Set<string>(),
    failures: 0,
  }));
}

function article(overrides: Partial<ConsensusArticle> = {}): ConsensusArticle {
  const now = Date.now();
  return {
    url: 'https://a.com/story',
    title: 'A story',
    summary: 'A summary.',
    publisher: 'a.com',
    published: now - 3600_000, // 1 h old → inside the window
    ...overrides,
  };
}

beforeEach(() => {
  resetCoverageCache();
  vi.mocked(resolveEmbeddingProvider).mockReturnValue(provider());
  vi.mocked(semanticEmbeddingsFor).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── detectWireMarker ────────────────────────────────────────────────────

describe('detectWireMarker', () => {
  it('flags wire credit lines in the lead', () => {
    expect(detectWireMarker('Hersteller kündigt neues Produkt an', 'Berlin (dpa) — Der Hersteller ...')).toBe(true);
    expect(detectWireMarker('Reuters: markets fall', '')).toBe(true);
    expect(detectWireMarker('Company says deal is off', 'AP reports that ...')).toBe(true);
    expect(detectWireMarker('City council votes', 'Keystone-SDA/ATS meldet ...')).toBe(true);
  });

  it('does not flag ordinary copy', () => {
    expect(detectWireMarker('Postgres 17 released', 'A new version ships today.')).toBe(false);
    expect(detectWireMarker('', '')).toBe(false);
  });

  it('ignores html tags and looks only at the lead', () => {
    const longSummary = ' '.repeat(600) + 'dpa mentions this late in the text';
    expect(detectWireMarker('A story', longSummary)).toBe(false);
  });
});

// ── clusterByAverageLinkage ─────────────────────────────────────────────

describe('clusterByAverageLinkage', () => {
  it('returns no clusters for an empty matrix', () => {
    expect(clusterByAverageLinkage([], TAU_STORY)).toEqual([]);
  });

  it('assigns the single item to cluster 0', () => {
    expect(clusterByAverageLinkage([[0]], TAU_STORY)).toEqual([0]);
  });

  it('merges two items above tau and separates those below', () => {
    const sim = [
      [0, 0.9],
      [0.9, 0],
    ];
    expect(clusterByAverageLinkage(sim, TAU_STORY)).toEqual([0, 0]);
    expect(clusterByAverageLinkage(sim, 0.95)).toEqual([0, 1]);
  });

  it('keeps unrelated items apart', () => {
    const sim = [
      [0, 0.2, 0.1],
      [0.2, 0, 0.3],
      [0.1, 0.3, 0],
    ];
    expect(clusterByAverageLinkage(sim, TAU_STORY)).toEqual([0, 1, 2]);
  });

  it('merges a chain through the average linkage rule', () => {
    // 0-1 strongly similar, 1-2 moderately similar: the 0/1 pair pulls 2 in
    // only if the average of (0,2) and (1,2) clears tau.
    const sim = [
      [0, 0.99, 0.5],
      [0.99, 0, 0.5],
      [0.5, 0.5, 0],
    ];
    // average of cluster {0,1} with {2} = (0.5 + 0.5) / 2 = 0.5 < 0.79 → apart.
    const apart = clusterByAverageLinkage(sim, TAU_STORY);
    expect(apart[0]).toBe(apart[1]);
    expect(apart[2]).not.toBe(apart[0]);
    // With tau 0.4 the whole chain merges into one cluster.
    const merged = clusterByAverageLinkage(sim, 0.4);
    expect(new Set(merged).size).toBe(1);
  });
});

// ── computeOrigins ──────────────────────────────────────────────────────

describe('computeOrigins', () => {
  const meta = (publisher: string, wire = false) => ({ publisher, wire });

  it('counts each publisher once within one story', () => {
    const members = [meta('a.com'), meta('a.com'), meta('b.com')];
    const sim = [
      [0, 0.9, 0.6],
      [0.9, 0, 0.6],
      [0.6, 0.6, 0],
    ];
    const { origins, publishers } = computeOrigins(members, sim, [0, 1, 2]);
    expect(origins).toBe(2);
    expect(publishers).toEqual(['a.com', 'b.com']);
  });

  it('adds one origin for a wire dispatch', () => {
    const members = [meta('a.com'), meta('a.com', true)];
    const sim = [
      [0, 0.9],
      [0.9, 0],
    ];
    const { origins } = computeOrigins(members, sim, [0, 1]);
    expect(origins).toBe(2);
  });

  it('collapses cross-publisher duplicate copies at tau_dup', () => {
    const members = [meta('a.com'), meta('b.com')];
    const sim = [
      [0, TAU_DUP],
      [TAU_DUP, 0],
    ];
    const { origins } = computeOrigins(members, sim, [0, 1]);
    expect(origins).toBe(1);
  });

  it('does not collapse pairs below tau_dup', () => {
    const members = [meta('a.com'), meta('b.com')];
    const sim = [
      [0, 0.9],
      [0.9, 0],
    ];
    const { origins } = computeOrigins(members, sim, [0, 1]);
    expect(origins).toBe(2);
  });

  it('counts wire members as at most one origin even when duplicated', () => {
    const members = [meta('a.com'), meta('a.com', true), meta('a.com', true)];
    const sim = [
      [0, 0.9, 0.9],
      [0.9, 0, 0.99],
      [0.9, 0.99, 0],
    ];
    const { origins } = computeOrigins(members, sim, [0, 1, 2]);
    expect(origins).toBe(2);
  });
});

// ── consensusBoost ──────────────────────────────────────────────────────

describe('consensusBoost', () => {
  it('gives a real zero for one or fewer origins', () => {
    expect(consensusBoost(0)).toBe(0);
    expect(consensusBoost(1)).toBe(0);
  });

  it('scales logarithmically and saturates at six origins', () => {
    expect(consensusBoost(2)).toBeCloseTo(Math.log(2) / Math.log(6), 6);
    expect(consensusBoost(3)).toBeCloseTo(Math.log(3) / Math.log(6), 6);
    expect(consensusBoost(5)).toBeCloseTo(Math.log(5) / Math.log(6), 6);
    expect(consensusBoost(6)).toBe(1);
    expect(consensusBoost(10)).toBe(1);
  });
});

// ── computeCoverage ─────────────────────────────────────────────────────

describe('computeCoverage', () => {
  it('returns provider-unavailable when no embedding provider is configured', async () => {
    vi.mocked(resolveEmbeddingProvider).mockReturnValue(null);
    const result = await computeCoverage([article()]);
    expect(result.status).toBe('provider-unavailable');
    expect(result.provider).toBeNull();
    expect(result.coverage).toEqual({});
    expect(result.missing).toHaveLength(1);
  });

  it('marks articles outside the 48 h window as excluded without embedding them', async () => {
    const old = article({ url: 'https://a.com/old', published: Date.now() - 10 * 24 * 3600_000 });
    const fresh = article({ url: 'https://a.com/fresh' });
    let embedCalls = 0;
    vi.mocked(semanticEmbeddingsFor).mockImplementation(async (_p, jobs: MockEmbedJob[]) => {
      embedCalls = jobs.length;
      return { vectors: jobs.map((job) => ({ key: job.key, vector: [1, 0] })), notAttempted: new Set<string>(), failures: 0 };
    });
    const result = await computeCoverage([old, fresh]);
    expect(embedCalls).toBe(1); // only the fresh article gets embedded
    expect(result.coverage[old.url]).toMatchObject({ excluded: true, origins: 0, boost: 0 });
    expect(result.coverage[fresh.url].excluded).toBe(false);
    expect(result.status).toBe('ok');
    expect(result.missing).toEqual([]);
  });

  it('excludes invalid publication dates', async () => {
    const bad = article({ url: 'https://a.com/bad', published: 0 });
    vi.mocked(semanticEmbeddingsFor).mockImplementation(async (_p, jobs: MockEmbedJob[]) => ({
      vectors: jobs.map((job) => ({ key: job.key, vector: [1, 0] })),
      notAttempted: new Set<string>(),
      failures: 0,
    }));
    const result = await computeCoverage([bad]);
    expect(result.coverage[bad.url].excluded).toBe(true);
  });

  it('clusters same-story articles from different publishers and boosts origins', async () => {
    const storyA = article({ url: 'https://a.com/story', title: 'Postgres 17 released', publisher: 'a.com' });
    const storyB = article({ url: 'https://b.com/story', title: 'Postgres 17 is out', publisher: 'b.com' });
    const textA = embeddingText(storyA.title, storyA.summary);
    const textB = embeddingText(storyB.title, storyB.summary);
    // Similar but NOT identical: dot product 0.9 clears TAU_STORY (0.79) and
    // stays below TAU_DUP (0.98), so they merge as one story with two origins.
    const vectorA = [1, 0];
    const vectorB = [0.9, Math.sqrt(1 - 0.9 ** 2)];
    const otherVector = [0, 1];
    stubEmbeddings({
      [embeddingCacheKey(model, textA)]: vectorA,
      [embeddingCacheKey(model, textB)]: vectorB,
      [embeddingCacheKey(model, embeddingText('Unrelated', 'Unrelated summary.'))]: otherVector,
    });
    const result = await computeCoverage([storyA, storyB]);
    expect(result.status).toBe('ok');
    expect(result.coverage[storyA.url].origins).toBe(2);
    expect(result.coverage[storyB.url].origins).toBe(2);
    expect(result.coverage[storyA.url].boost).toBeCloseTo(Math.log(2) / Math.log(6), 6);
    expect(result.coverage[storyA.url].publishers).toEqual(['a.com', 'b.com']);
  });

  it('gives a real zero when a story has a single origin', async () => {
    const story = article({ url: 'https://a.com/alone', title: 'A unique story' });
    stubEmbeddings({ [embeddingCacheKey(model, embeddingText(story.title, story.summary))]: [1, 0] });
    const result = await computeCoverage([story]);
    expect(result.coverage[story.url]).toMatchObject({ origins: 1, boost: 0, excluded: false });
  });

  it('reports missing articles as partial when vectors are pending', async () => {
    const story = article({ url: 'https://a.com/missing' });
    // Return no vectors at all: the article stays pending.
    vi.mocked(semanticEmbeddingsFor).mockImplementation(async () => ({ vectors: [], notAttempted: new Set<string>(), failures: 0 }));
    const result = await computeCoverage([story]);
    expect(result.status).toBe('partial');
    expect(result.missing).toEqual([story.url]);
    expect(result.coverage[story.url]).toBeUndefined();
  });

  it('caches a complete cohort result for five minutes', async () => {
    const story = article({ url: 'https://a.com/cached' });
    stubEmbeddings({ [embeddingCacheKey(model, embeddingText(story.title, story.summary))]: [1, 0] });
    const first = await computeCoverage([story]);
    const second = await computeCoverage([story]);
    expect(second).toEqual(first);
    expect(semanticEmbeddingsFor).toHaveBeenCalledTimes(1);
  });

  it('recomputes when the cohort changes', async () => {
    const a = article({ url: 'https://a.com/cached' });
    const b = article({ url: 'https://b.com/other' });
    stubEmbeddings({
      [embeddingCacheKey(model, embeddingText(a.title, a.summary))]: [1, 0],
      [embeddingCacheKey(model, embeddingText(b.title, b.summary))]: [0, 1],
    });
    await computeCoverage([a]);
    await computeCoverage([b]);
    expect(semanticEmbeddingsFor).toHaveBeenCalledTimes(2);
  });

  it('keeps the cohort cache bounded at eight entries', async () => {
    stubEmbeddings({});
    const articles: ConsensusArticle[] = [];
    for (let i = 0; i < 10; i++) {
      articles.push(article({ url: `https://site${i}.com/story`, title: `Story number ${i}` }));
    }
    // Each call with a distinct cohort → each recomputed (vectors pending).
    for (let i = 0; i < articles.length; i++) {
      await computeCoverage(articles.slice(0, i + 1));
    }
    // No crash, results present.
    const last = await computeCoverage(articles);
    expect(last.status).toBe('partial');
  });
});

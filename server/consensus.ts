import { createHash } from 'node:crypto';
import db from './db.js';
import { embeddingCacheKey, embeddingText } from './semanticScoring.js';
import { resolveEmbeddingProvider } from './semanticEmbeddings.js';
import { semanticEmbeddingsFor } from './semanticEmbeddingService.js';

// ═══════════════════════════════════════════════════════════════════════
// Publisher-consensus signal (rework §4.6, Phase 3).
//
// One origin = one independent editorial decision. Members of a cluster are
// grouped by publisher (same publisher counts once), wire copies join the
// wire origin instead of their carrier's publisher, and cross-publisher
// pairs at or above `TAU_DUP` (identical copies) collapse. The boost is
// min(1, ln(origins)/ln(6)): two origins give a solid boost, five or more
// saturate at 1. One origin is a REAL zero — a genuine measured value —
// not a penalty.
//
// Calibration (evaluation/consensus-calibration-report.md, owner labels on
// 51 stratified pairs from the live cohort, bge-m3, prep_version 1):
//   TAU_STORY = 0.79 — every raw-pair error at this cut is a same-publisher
//   pair (harmless for the origins metric); all cross-publisher pairs ≥ 0.79
//   are genuinely the same story.
//   TAU_DUP = 0.98 — midpoint of the observed gap (independent same-story
//   pairs top out at 0.9618; duplicate-marked pairs start at 0.9958).
//
// Known inflation source for Phase 6 (documented, no tau change now): FAZ
// feed content embeds "Empfehlungen" teasers, which can inflate same-
// publisher similarities. This only over-collapses within one publisher
// group, which the origins metric already counts as one.
// ═══════════════════════════════════════════════════════════════════════

export const TAU_STORY = 0.79;
export const TAU_DUP = 0.98;

/** Same rule the calibration review used to flag wire copies. */
const WIRE_MARKERS = /\b(dpa|DPAny|Reuters|AFP|AP\b|APA\b|SDA\b|Keystone)/;

/** Look at the lead only: wires carry their credit line up front. */
export function detectWireMarker(title: string, summary: string): boolean {
  const lead = ((title || '') + ' ' + (summary || '')).replace(/<[^>]+>/gs, ' ').slice(0, 500);
  return WIRE_MARKERS.test(lead);
}

export const MAX_CANDIDATES = 300;
/** Only recent reporting corroborates: the 48-hour window of the rework. */
export const COVERAGE_WINDOW_MS = 48 * 3600_000;
/** Complete cohort results are reused for five minutes (rework §4.6). */
const COVERAGE_CACHE_TTL_MS = 5 * 60_000;
/** Bounded, resumable embedding batches per request. */
const MAX_EMBEDS_PER_REQUEST = 128;

export interface ConsensusArticle {
  url: string;
  title: string;
  summary: string;
  /** Client-computed feed publisher (normalized site host); may be empty. */
  publisher: string;
  published: number;
}

export interface CoverageEntry {
  origins: number;
  publishers: string[];
  clusterId: string;
  boost: number;
  /** Outside the 48 h window: neutral, not-applicable on the wire. */
  excluded: boolean;
}

export interface CoverageResult {
  status: 'ok' | 'partial' | 'provider-unavailable';
  coverage: Record<string, CoverageEntry>;
  missing: string[];
  provider: 'openrouter' | 'ollama' | null;
}

// ── Clustering (average-linkage agglomerative) ─────────────────────────

/**
 * Average-linkage agglomerative clustering over a precomputed similarity
 * matrix. Returns one cluster index per item. Clusters merge while the
 * average similarity between them stays at or above `tau`.
 */
export function clusterByAverageLinkage(similarity: number[][], tau: number): number[] {
  const n = similarity.length;
  if (n === 0) return [];
  if (n === 1) return [0];

  // Cluster ids are stable and monotonically increasing: removing and adding
  // clusters never re-indexes the other members, so sum keys stay valid.
  interface Cluster { id: number; members: number[] }
  let clusters: Cluster[] = Array.from({ length: n }, (_, i) => ({ id: i, members: [i] }));
  let nextId = n;
  const sums = new Map<string, number>();
  const key = (a: number, b: number) => (a < b ? a + ':' + b : b + ':' + a);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) sums.set(key(i, j), similarity[i][j]);
  }

  while (clusters.length > 1) {
    let bestA: Cluster | null = null;
    let bestB: Cluster | null = null;
    let bestAvg = tau;
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        const avg = (sums.get(key(clusters[a].id, clusters[b].id)) ?? 0)
          / (clusters[a].members.length * clusters[b].members.length);
        if (avg > bestAvg) { bestAvg = avg; bestA = clusters[a]; bestB = clusters[b]; }
      }
    }
    if (!bestA || !bestB) break;
    // Merge; Lance-Williams update for average linkage:
    // sum(merged, c) = sum(a, c) + sum(b, c).
    const merged: Cluster = { id: nextId++, members: [...bestA.members, ...bestB.members] };
    clusters = clusters.filter((cluster) => cluster !== bestA && cluster !== bestB);
    for (const cluster of clusters) {
      const sumAC = sums.get(key(bestA.id, cluster.id)) ?? 0;
      const sumBC = sums.get(key(bestB.id, cluster.id)) ?? 0;
      sums.delete(key(bestA.id, cluster.id));
      sums.delete(key(bestB.id, cluster.id));
      sums.set(key(merged.id, cluster.id), sumAC + sumBC);
    }
    sums.delete(key(bestA.id, bestB.id));
    clusters.push(merged);
  }

  const result = new Array<number>(n).fill(0);
  clusters.forEach((cluster, clusterIndex) => {
    for (const member of cluster.members) result[member] = clusterIndex;
  });
  return result;
}

/**
 * Count independent editorial origins in one story cluster.
 * - Non-wire members group by publisher; each publisher counts once.
 * - Cross-publisher pairs at or above `TAU_DUP` collapse (identical copies).
 * - Wire copies form at most one additional origin (the dispatch itself).
 * Returns the distinct publisher names for display.
 */
export function computeOrigins(
  members: Array<{ publisher: string; wire: boolean }>,
  similarity: number[][],
  memberIndices: number[],
): { origins: number; publishers: string[] } {
  const wireMembers = memberIndices.filter((index) => members[index].wire);
  const nonWire = memberIndices.filter((index) => !members[index].wire);

  // Union-find over publisher groups.
  const parent = new Map<string, string>();
  const find = (publisher: string): string => {
    let root = publisher;
    while (parent.get(root) !== root) root = parent.get(root) ?? root;
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const index of nonWire) {
    const publisher = members[index].publisher;
    if (!parent.has(publisher)) parent.set(publisher, publisher);
  }
  // Collapse cross-publisher duplicates (tau_dup pairs).
  for (let x = 0; x < nonWire.length; x++) {
    for (let y = x + 1; y < nonWire.length; y++) {
      const ix = nonWire[x];
      const iy = nonWire[y];
      const publisherX = members[ix].publisher;
      const publisherY = members[iy].publisher;
      if (publisherX !== publisherY && (similarity[ix][iy] ?? 0) >= TAU_DUP) union(publisherX, publisherY);
    }
  }
  const distinctPublishers = new Set(nonWire.map((index) => find(members[index].publisher)));
  const origins = distinctPublishers.size + (wireMembers.length ? 1 : 0);
  const publishers = [...new Set(memberIndices.map((index) => members[index].publisher))].sort();
  return { origins, publishers };
}

/** min(1, ln(origins)/ln(6)); one origin is a real zero, five or more saturate. */
export function consensusBoost(origins: number): number {
  if (origins <= 1) return 0;
  return Math.max(0, Math.min(1, Math.log(origins) / Math.log(6)));
}

// ── Cohort-level orchestration (used by the /coverage route) ───────────

const coverageCache = new Map<string, { expiresAt: number; result: CoverageResult }>();

function cohortHash(articles: ConsensusArticle[]): string {
  const canonical = [...articles]
    .map((article) => article.url + '\u001f' + String(article.published))
    .sort()
    .join('\u001e');
  return createHash('sha256').update(canonical).digest('hex');
}

function hostFromUrl(raw: string): string {
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Publisher-consensus coverage for one request cohort. Embeddings run in
 * bounded batches and `missing` lists the articles whose vectors are still
 * pending, so the client polls. Complete results are cached for five
 * minutes keyed by the cohort (sorted urls + publication times).
 */
export async function computeCoverage(articles: ConsensusArticle[]): Promise<CoverageResult> {
  const now = Date.now();
  const hash = cohortHash(articles);
  const cached = coverageCache.get(hash);
  if (cached && cached.expiresAt > now) return cached.result;

  const provider = resolveEmbeddingProvider();
  if (!provider) {
    return { status: 'provider-unavailable', coverage: {}, missing: articles.map((article) => article.url), provider: null };
  }

  // The 48-hour window: older candidates are neutral, not missing.
  const included: ConsensusArticle[] = [];
  const coverage: Record<string, CoverageEntry> = {};
  for (const article of articles) {
    const excluded = !(article.published > 0 && now - article.published >= 0 && now - article.published <= COVERAGE_WINDOW_MS);
    if (excluded) {
      coverage[article.url] = { origins: 0, publishers: [], clusterId: '', boost: 0, excluded: true };
    } else {
      included.push(article);
    }
  }

  const jobs = included.map((article) => {
    const text = embeddingText(article.title, article.summary);
    return { article, text, key: embeddingCacheKey(provider.model, text) };
  });
  const embedResult = await semanticEmbeddingsFor(provider, jobs, MAX_EMBEDS_PER_REQUEST);
  const vectorByKey = new Map(embedResult.vectors.map((entry) => [entry.key, entry.vector]));

  const embedded = jobs.filter((job) => vectorByKey.has(job.key));
  const missing = jobs.filter((job) => !vectorByKey.has(job.key)).map((job) => job.article.url);

  // Cluster only fully-embedded subsets: a poll that leaves gaps must not
  // split one story across a partial cohort.
  const similarity: number[][] = embedded.map(() => new Array<number>(embedded.length).fill(0));
  for (let i = 0; i < embedded.length; i++) {
    const vi = vectorByKey.get(embeddingCacheKey(provider.model, embedded[i].text))!;
    for (let j = i + 1; j < embedded.length; j++) {
      const vj = vectorByKey.get(embeddingCacheKey(provider.model, embedded[j].text))!;
      let dot = 0;
      for (let k = 0; k < Math.min(vi.length, vj.length); k++) dot += vi[k] * vj[k];
      similarity[i][j] = dot;
      similarity[j][i] = dot;
    }
  }
  const memberMeta = embedded.map((job) => ({
    publisher: job.article.publisher || hostFromUrl(job.article.url),
    wire: detectWireMarker(job.article.title, job.article.summary),
  }));
  const clusterIndex = clusterByAverageLinkage(similarity, TAU_STORY);

  // Group embedded indices by cluster, then compute origins per cluster.
  const clusterMembers = new Map<number, number[]>();
  embedded.forEach((_, index) => {
    const members = clusterMembers.get(clusterIndex[index]) ?? [];
    members.push(index);
    clusterMembers.set(clusterIndex[index], members);
  });
  for (const [, members] of clusterMembers) {
    const { origins, publishers } = computeOrigins(memberMeta, similarity, members);
    const boost = consensusBoost(origins);
    const clusterId = 'story-' + createHash('sha256')
      .update(members.map((index) => embedded[index].article.url).sort().join('\u001e'))
      .digest('hex').slice(0, 12);
    for (const index of members) {
      coverage[embedded[index].article.url] = { origins, publishers, clusterId, boost, excluded: false };
    }
  }

  const result: CoverageResult = {
    status: missing.length ? 'partial' : 'ok',
    coverage,
    missing,
    provider: provider.id,
  };
  if (!missing.length) {
    coverageCache.set(hash, { expiresAt: now + COVERAGE_CACHE_TTL_MS, result });
    // Keep the cache bounded: at most 8 cohorts.
    while (coverageCache.size > 8) {
      const oldest = [...coverageCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
      if (!oldest) break;
      coverageCache.delete(oldest[0]);
    }
  }
  return result;
}

/** Test hook: clear the five-minute cohort cache. */
export function resetCoverageCache(): void {
  coverageCache.clear();
}

/** Exposed for the evaluation script (Phase 6 calibration tooling). */
export const consensusTables = {
  get hasEmbeddingCache(): boolean {
    return db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='semantic_embedding_cache'`)
      .get() !== undefined;
  },
};

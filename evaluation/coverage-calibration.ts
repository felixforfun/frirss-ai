/**
 * Phase 3.4 calibration tool (brief, "Ranking Rework", §Phase 3.4):
 *
 *   dump the pairwise similarity histogram and a labeling sheet of about 50
 *   pairs stratified across similarity bins, labeled same-story, related or
 *   different (the owner reviews the labels). Choose tau_story and tau_dup
 *   from the labels, commit them as constants with the calibration report.
 *
 * The committed constants live in `server/consensus.ts` (TAU_STORY, TAU_DUP);
 * the derivation they came from is `evaluation/consensus-calibration-report.md`
 * (2026-11-02, 51 labeled pairs). This script is the durable form of the tool
 * that produced that run's artifacts — re-run it on a fresh cohort whenever
 * the text preprocessing changes (the report's "if prep changes, tau must be
 * re-derived" rule).
 *
 * Usage:
 *   npx tsx evaluation/coverage-calibration.ts <cohort.json> [options]
 *
 *   cohort.json  Array of articles: [{ url, title, summary, feed, host, date, wire? }]
 *                (a dump of the recent FreshRSS cohort; `date` in ms epoch)
 *   --vectors f  Optional JSON map url -> number[] with precomputed embeddings
 *                (skips the provider call entirely)
 *   --pairs N    Labeling-sheet size (default 51, as in the committed run)
 *
 * Environment: OPENROUTER_API_KEY (embedding provider) unless --vectors is given.
 *
 * Outputs (next to this script):
 *   histogram.json   census of all pairwise cosines, binned at 0.02
 *   pairs-review.json  stratified sample for owner labeling; the labels are
 *                      collected in the interactive review and recorded in the
 *                      calibration report (see frirss-consensus-labels-*.json
 *                      for the committed run's decisions)
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveEmbeddingProvider } from '../server/semanticEmbeddings.js';
import { embeddingText } from '../server/semanticScoring.js';
import { detectWireMarker } from '../server/consensus.js';

interface CohortArticle {
  url: string;
  title: string;
  summary: string;
  feed: string;
  host: string;
  date: number;
  wire?: boolean;
}

interface PairSide {
  title: string;
  feed: string;
  snippet: string;
  host: string;
  date: number;
  wire: boolean;
}

interface Pair {
  sim: number;
  a: PairSide;
  b: PairSide;
}

const BIN = 0.02;
const SNIPPET_CHARS = 150;

/** Unit-normalize, then dot — identical to the production consensus metric. */
function cosine(u: number[], v: number[]): number {
  let nu = 0;
  let nv = 0;
  for (let i = 0; i < Math.min(u.length, v.length); i++) {
    nu += u[i] * u[i];
    nv += v[i] * v[i];
  }
  if (nu === 0 || nv === 0) return 0;
  let dot = 0;
  for (let i = 0; i < Math.min(u.length, v.length); i++) dot += u[i] * v[i];
  return dot / (Math.sqrt(nu) * Math.sqrt(nv));
}

function side(article: CohortArticle): PairSide {
  return {
    title: article.title,
    feed: article.feed,
    snippet: (article.title + ' ' + article.summary).slice(0, SNIPPET_CHARS),
    host: article.host,
    date: article.date,
    wire: article.wire ?? detectWireMarker(article.title, article.summary),
  };
}

/**
 * Stratified sampling weighted toward the 0.6–0.9 band, where the story
 * boundary lives; the top bins stay thin on purpose (a 300-article cohort has
 * only a handful of pairs above 0.88 — see the committed report).
 */
function samplePairs(candidates: Map<number, Pair[]>, total: number): Pair[] {
  const band = (sim: number): string =>
    sim < 0.2 ? 'a' : sim < 0.4 ? 'b' : sim < 0.6 ? 'c' : sim < 0.7 ? 'd' : sim < 0.8 ? 'e' : sim < 0.9 ? 'f' : 'g';
  // Rough allocation of the sheet across bands, tuned in the committed run.
  const weights: Record<string, number> = { a: 0.08, b: 0.14, c: 0.16, d: 0.18, e: 0.18, f: 0.16, g: 0.10 };
  const byBand: Record<string, Pair[]> = {};
  for (const [, pairs] of candidates) {
    const key = band(pairs[0]?.sim ?? 0);
    (byBand[key] ??= []).push(...pairs);
  }
  const picked: Pair[] = [];
  for (const [key, pool] of Object.entries(byBand)) {
    const want = Math.max(1, Math.round(weights[key] * total));
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    picked.push(...shuffled.slice(0, want));
  }
  // Fill any shortfall from whatever bands still have unpicked pairs.
  if (picked.length < total) {
    const chosen = new Set(picked);
    const rest = [...byBand.a ?? [], ...byBand.b ?? [], ...byBand.c ?? [], ...byBand.d ?? [], ...byBand.e ?? [], ...byBand.f ?? [], ...byBand.g ?? []]
      .filter((p) => !chosen.has(p))
      .sort(() => Math.random() - 0.5);
    picked.push(...rest.slice(0, total - picked.length));
  }
  return picked.sort((x, y) => y.sim - x.sim);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cohortPath = args[0];
  if (!cohortPath) {
    console.error('usage: tsx evaluation/coverage-calibration.ts <cohort.json> [--vectors f] [--pairs N]');
    process.exit(1);
  }
  const vectorsArg = args.includes('--vectors') ? args[args.indexOf('--vectors') + 1] : undefined;
  const pairCount = args.includes('--pairs') ? Number(args[args.indexOf('--pairs') + 1]) || 51 : 51;

  const cohort: CohortArticle[] = JSON.parse(fs.readFileSync(cohortPath, 'utf8'));
  const here = path.dirname(fileURLToPath(import.meta.url));

  let vectors: Map<string, number[]>;
  if (vectorsArg) {
    vectors = new Map(Object.entries(JSON.parse(fs.readFileSync(vectorsArg, 'utf8')) as Record<string, number[]>));
  } else {
    const provider = resolveEmbeddingProvider();
    if (!provider) {
      console.error('no embedding provider configured (set OPENROUTER_API_KEY) or pass --vectors');
      process.exit(1);
    }
    const texts = cohort.map((a) => embeddingText(a.title, a.summary));
    vectors = new Map();
    for (let i = 0; i < texts.length; i += 32) {
      const batch = texts.slice(i, i + 32);
      const batchVectors = await provider.embed(batch);
      for (let j = 0; j < batch.length; j++) vectors.set(cohort[i + j].url, batchVectors[j]);
      console.error(`embedded ${Math.min(i + 32, texts.length)}/${texts.length}`);
    }
  }

  // Census: every pairwise cosine of the usable cohort.
  const embedded = cohort.filter((a) => vectors.has(a.url));
  const histogram: Record<string, number> = {};
  const byBin: Map<number, Pair[]> = new Map();
  let totalPairs = 0;
  for (let i = 0; i < embedded.length; i++) {
    for (let j = i + 1; j < embedded.length; j++) {
      const sim = cosine(vectors.get(embedded[i].url)!, vectors.get(embedded[j].url)!);
      const key = (Math.floor(sim / BIN) * BIN).toFixed(2);
      histogram[key] = (histogram[key] ?? 0) + 1;
      const bin = Math.floor(sim / BIN);
      let bucket = byBin.get(bin);
      if (!bucket) { bucket = []; byBin.set(bin, bucket); }
      bucket.push({ sim: Number(sim.toFixed(4)), a: side(embedded[i]), b: side(embedded[j]) });
      totalPairs++;
    }
  }

  fs.writeFileSync(path.join(here, 'histogram.json'), JSON.stringify({ usableVectors: embedded.length, totalPairs, hist: histogram }, null, 2));
  const pairs = samplePairs(byBin, pairCount);
  fs.writeFileSync(path.join(here, 'pairs-review.json'), JSON.stringify(pairs, null, 2));
  console.error(`wrote histogram.json (${totalPairs} pairs) and pairs-review.json (${pairs.length} pairs)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

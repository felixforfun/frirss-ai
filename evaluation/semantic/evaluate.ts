/**
 * Real-vote semantic ranking evaluation.
 * Run: npm run eval:semantic -- --input /path/to/frirss-votes.json
 * Requires Ollama with the requested embedding model. Vote data and vectors
 * remain local; this script does not modify production ranking or server code.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { rankInterestingArticles } from '../../src/lib/intelligenceRanking';
import type { Article } from '../../src/types/index';
import type { ArticleFeedback as Feedback } from '../../src/api/intelligence';

type Label = 1 | -1;
type Variant = 'title+summary' | 'title+summary+lead1000';
type Method = 'centroid' | 'knn15' | 'multicentroid5';
interface Vote { id: string; vote: Label; title: string; summary: string; content: string; url: string; source: string; createdAt: string; updatedAt: string; text: Record<Variant, string> }
interface Options { input: string; url: string; model: string; cache: string; out?: string; folds: number; repeats: number; bootstrap: number; batch: number }
interface Metrics { auc: number; ap: number; p10: number; ndcg10: number; prevalence: number }
const variants: Array<{ key: Variant; label: string; lead: number }> = [
  { key: 'title+summary', label: 'Title + summary', lead: 0 },
  { key: 'title+summary+lead1000', label: 'Title + summary + first 1,000 content chars', lead: 1000 },
];
const normVersion = 'html-v1-title2000-summary2000-contentlead1000';
const fixedNow = Date.UTC(2026, 9, 25, 0, 0, 0);
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; };
const intOpt = (name: string, fallback: number) => { const n = Number(opt(name) ?? fallback); if (!Number.isInteger(n) || n < 1) throw new Error('--' + name + ' must be a positive integer'); return n; };
function options(): Options {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Options: --input PATH --ollama-url URL --model NAME --cache PATH --out PATH --folds N --repeats N --bootstrap N --batch-size N\nDefaults: input=/boot/config/plugins/user.scripts/frirss-votes.json, Ollama=http://127.0.0.1:11434, model=bge-m3, folds=5, repeats=5.');
    process.exit(0);
  }
  return {
    input: resolve(opt('input') || process.env.FRIRSS_VOTES_JSON || '/boot/config/plugins/user.scripts/frirss-votes.json'),
    url: (opt('ollama-url') || process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, ''),
    model: opt('model') || process.env.OLLAMA_MODEL || 'bge-m3',
    cache: resolve(opt('cache') || process.env.FRIRSS_SEMANTIC_CACHE || resolve(homedir(), '.cache/frirss-semantic-eval.sqlite')),
    out: opt('out') ? resolve(opt('out')!) : undefined,
    folds: intOpt('folds', 5), repeats: intOpt('repeats', 5), bootstrap: intOpt('bootstrap', 1000), batch: intOpt('batch-size', 8),
  };
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function plain(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.slice(0, 200000)
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style|noscript)\b[\s\S]*$/i, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,16});/gi, (_m, e: string) => {
      if (e[0] === '#') { const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '; }
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: ' ', mdash: ' ', ndash: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß' } as Record<string, string>)[e.toLowerCase()] ?? ' ';
    }).replace(/\s+/g, ' ').trim();
}
function canonical(raw: string): string {
  try {
    const u = new URL(raw); u.hash = ''; u.hostname = u.hostname.toLowerCase().replace(/^www\./, ''); u.protocol = 'https:';
    for (const key of [...u.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$|ref$|source$)/i.test(key)) u.searchParams.delete(key);
    u.searchParams.sort(); u.pathname = u.pathname.replace(/\/+$/, '') || '/'; return u.toString();
  } catch { return raw.trim(); }
}
function readVotes(path: string): { votes: Vote[]; duplicateCount: number; conflicts: number } {
  if (!existsSync(path)) throw new Error('Vote export not found: ' + path + '. Pass --input PATH or set FRIRSS_VOTES_JSON.');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Array<Record<string, unknown>>;
  if (!Array.isArray(raw)) throw new Error('Vote export must be a JSON array.');
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const item of raw) {
    if ((item.vote !== 1 && item.vote !== -1) || typeof item.title !== 'string') continue;
    const url = typeof item.url === 'string' ? canonical(item.url) : '';
    const key = url || hash(String(item.title) + '\n' + String(item.source ?? ''));
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const votes: Vote[] = []; let duplicateCount = 0; let conflicts = 0;
  for (const [key, group] of groups) {
    duplicateCount += group.length - 1;
    if (new Set(group.map((x) => x.vote)).size > 1) { conflicts++; continue; }
    const x = [...group].sort((a, b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')))[0];
    const title = plain(x.title); const summary = plain(x.summary); const content = plain(x.content);
    const text = {} as Record<Variant, string>;
    for (const v of variants) text[v.key] = [title.slice(0, 2000), summary.slice(0, 2000), v.lead ? content.slice(0, v.lead) : ''].filter(Boolean).join('\n\n').replace(/\s+/g, ' ').trim();
    votes.push({ id: 'vote:' + hash(key).slice(0, 40), vote: x.vote as Label, title, summary, content, url: String(x.url ?? ''), source: String(x.source ?? ''), createdAt: String(x.createdAt ?? ''), updatedAt: String(x.updatedAt ?? x.createdAt ?? ''), text });
  }
  votes.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  return { votes, duplicateCount, conflicts };
}
async function json<T>(url: string, body?: unknown): Promise<T> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 180000);
  try {
    const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    const text = await r.text(); if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url + ': ' + text.slice(0, 300)); return JSON.parse(text) as T;
  } finally { clearTimeout(timer); }
}
function unit(v: number[]): number[] { const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); if (!norm || !Number.isFinite(norm)) throw new Error('Invalid embedding vector'); return v.map((x) => x / norm); }
const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
function meanVector(vectors: number[][]): number[] { if (!vectors.length) return []; const out = new Array(vectors[0].length).fill(0); for (const v of vectors) v.forEach((x, i) => { out[i] += x; }); return unit(out); }
function random(seed: number): () => number { let s = seed >>> 0; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
function shuffled<T>(xs: T[], rnd: () => number): T[] { const out = [...xs]; for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; }
function splits(votes: Vote[], k: number, repeats: number): number[][][] {
  const pos = votes.map((v, i) => v.vote === 1 ? i : -1).filter((i) => i >= 0);
  const neg = votes.map((v, i) => v.vote === -1 ? i : -1).filter((i) => i >= 0);
  if (pos.length < k || neg.length < k) throw new Error('Need at least ' + k + ' examples per class.');
  return Array.from({ length: repeats }, (_, r) => {
    const rnd = random(20261025 + r * 997); const buckets = Array.from({ length: k }, () => [] as number[]);
    for (const group of [shuffled(pos, rnd), shuffled(neg, rnd)]) group.forEach((i, j) => buckets[j % k].push(i));
    return buckets;
  });
}
function article(v: Vote): Article {
  return { id: v.id, title: v.title, summary: v.summary, content: v.content, author: '', url: v.url, source: v.source, sourceId: v.source, published: fixedNow, publishedMissing: true, read: false, starred: false, labels: [], tags: [] };
}
function feedback(v: Vote): Feedback {
  return { articleId: v.id, url: v.url, title: v.title, summary: v.summary, content: v.content, sourceId: v.source, vote: v.vote, createdAt: v.createdAt, updatedAt: v.updatedAt };
}
function percentiles(scores: number[]): number[] {
  const sorted = scores.map((score, i) => ({ score, i })).sort((a, b) => b.score - a.score || a.i - b.i); const out = new Array(scores.length).fill(0);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1; while (end < sorted.length && Math.abs(sorted[end].score - sorted[start].score) < 1e-12) end++;
    const p = sorted.length < 2 ? 1 : 1 - ((start + end - 1) / 2) / (sorted.length - 1);
    for (let i = start; i < end; i++) out[sorted[i].i] = p;
    start = end;
  }
  return out;
}
function orderedScores(candidates: Article[], ranked: Article[]): number[] {
  const ranks = new Map(ranked.map((v, i) => [v.id, i]));
  return percentiles(candidates.map((v) => -(ranks.get(v.id) ?? ranked.length)));
}
function centroidScores(train: Vote[], test: Vote[], vec: Map<string, number[]>): number[] {
  const p = meanVector(train.filter((v) => v.vote === 1).map((v) => vec.get(v.id)!));
  const n = meanVector(train.filter((v) => v.vote === -1).map((v) => vec.get(v.id)!));
  return test.map((v) => (p.length ? dot(vec.get(v.id)!, p) : 0) - (n.length ? dot(vec.get(v.id)!, n) : 0));
}
function knnScores(train: Vote[], test: Vote[], vec: Map<string, number[]>): number[] {
  return test.map((v) => {
    const near = train.map((t) => ({ y: t.vote === 1 ? 1 : 0, s: dot(vec.get(v.id)!, vec.get(t.id)!) })).sort((a, b) => b.s - a.s).slice(0, 15);
    let yes = 0; let total = 0; for (const x of near) { const w = Math.max(0.01, (x.s + 1) / 2); yes += x.y * w; total += w; } return total ? yes / total : 0.5;
  });
}
function kmeans(vectors: number[][], requested: number, seed: number): number[][] {
  if (!vectors.length) return []; const k = Math.min(requested, vectors.length); const centers = [vectors[seed % vectors.length]];
  while (centers.length < k) { let chosen = vectors[0]; let far = -Infinity; for (const v of vectors) { const d = 1 - Math.max(...centers.map((c) => dot(v, c))); if (d > far) { far = d; chosen = v; } } centers.push(chosen); }
  for (let iter = 0; iter < 8; iter++) {
    const sums = Array.from({ length: k }, () => new Array(vectors[0].length).fill(0)); const counts = new Array(k).fill(0);
    for (const v of vectors) { let best = 0; let sim = -Infinity; centers.forEach((c, i) => { const s = dot(v, c); if (s > sim) { sim = s; best = i; } }); counts[best]++; v.forEach((x, i) => { sums[best][i] += x; }); }
    for (let i = 0; i < k; i++) if (counts[i]) centers[i] = unit(sums[i]);
  }
  return centers;
}
function multiScores(train: Vote[], test: Vote[], vec: Map<string, number[]>, seed: number): number[] {
  const p = kmeans(train.filter((v) => v.vote === 1).map((v) => vec.get(v.id)!), 5, seed);
  const n = kmeans(train.filter((v) => v.vote === -1).map((v) => vec.get(v.id)!), 5, seed + 17);
  return test.map((v) => Math.max(...p.map((c) => dot(vec.get(v.id)!, c)), -1) - Math.max(...n.map((c) => dot(vec.get(v.id)!, c)), -1));
}
function scoreFold(train: Vote[], test: Vote[], vectors: Map<string, Map<Variant, number[]>>, seed: number): Map<string, number[]> {
  const out = new Map<string, number[]>(); const candidates = test.map(article); const fb = train.map(feedback);
  const current = orderedScores(candidates, rankInterestingArticles(candidates, fb, fixedNow, 'current'));
  const next = orderedScores(candidates, rankInterestingArticles(candidates, fb, fixedNow, 'intelligence-next'));
  out.set('Baseline: Current', current); out.set('Baseline: Intelligence Next', next);
  for (const variant of variants) {
    const vec = new Map<string, number[]>(); for (const v of [...train, ...test]) vec.set(v.id, vectors.get(v.id)![variant.key]);
    const methods: Record<Method, number[]> = {
      centroid: percentiles(centroidScores(train, test, vec)),
      knn15: percentiles(knnScores(train, test, vec)),
      multicentroid5: percentiles(multiScores(train, test, vec, seed)),
    };
    for (const method of Object.keys(methods) as Method[]) {
      const name = variant.key + ' / ' + method; out.set(name, methods[method]);
      for (const lambda of [25, 50, 75]) out.set(variant.key + ' / hybrid-' + method + '-' + lambda, next.map((s, i) => s * (1 - lambda / 100) + methods[method][i] * lambda / 100));
    }
  }
  return out;
}
function auc(labels: Label[], scores: number[]): number {
  const p = labels.filter((x) => x === 1).length; const n = labels.length - p; if (!p || !n) return NaN;
  const xs = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s); let sum = 0;
  for (let start = 0; start < xs.length;) { let end = start + 1; while (end < xs.length && Math.abs(xs[end].s - xs[start].s) < 1e-12) end++; const rank = (start + 1 + end) / 2; for (let i = start; i < end; i++) if (xs[i].y === 1) sum += rank; start = end; }
  return (sum - p * (p + 1) / 2) / (p * n);
}
function ap(labels: Label[], scores: number[]): number {
  const p = labels.filter((x) => x === 1).length; if (!p) return NaN;
  const xs = scores.map((s, i) => ({ s, y: labels[i], i })).sort((a, b) => b.s - a.s || a.i - b.i); let hits = 0; let total = 0;
  xs.forEach((x, i) => { if (x.y === 1) { hits++; total += hits / (i + 1); } }); return total / p;
}
function metrics(labels: Label[], scores: number[]): Metrics {
  const order = scores.map((s, i) => ({ s, y: labels[i], i })).sort((a, b) => b.s - a.s || a.i - b.i);
  const top = order.slice(0, Math.min(10, order.length)); const dcg = top.reduce((sum, x, i) => sum + (x.y === 1 ? 1 / Math.log2(i + 2) : 0), 0);
  const idealN = Math.min(10, labels.filter((x) => x === 1).length); const ideal = Array.from({ length: idealN }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  return { auc: auc(labels, scores), ap: ap(labels, scores), p10: top.filter((x) => x.y === 1).length / Math.max(1, top.length), ndcg10: ideal ? dcg / ideal : NaN, prevalence: labels.filter((x) => x === 1).length / labels.length };
}
const avg = (xs: number[]) => { const ok = xs.filter(Number.isFinite); return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : NaN; };
const fmt = (x: number) => Number.isFinite(x) ? x.toFixed(3) : 'n/a';
function bootstrap(labels: Label[], scores: number[], count: number, seed: number): { auc: [number, number]; ap: [number, number] } {
  const pos = labels.map((x, i) => x === 1 ? i : -1).filter((i) => i >= 0); const neg = labels.map((x, i) => x === -1 ? i : -1).filter((i) => i >= 0);
  const rnd = random(seed); const aa: number[] = []; const pp: number[] = [];
  for (let b = 0; b < count; b++) { const ix: number[] = []; for (let i = 0; i < pos.length; i++) ix.push(pos[Math.floor(rnd() * pos.length)]); for (let i = 0; i < neg.length; i++) ix.push(neg[Math.floor(rnd() * neg.length)]); const y = ix.map((i) => labels[i]); const s = ix.map((i) => scores[i]); aa.push(auc(y, s)); pp.push(ap(y, s)); }
  const bounds = (xs: number[]): [number, number] => { xs.sort((a, b) => a - b); return [xs[Math.floor(xs.length * 0.025)], xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.975))]]; };
  return { auc: bounds(aa), ap: bounds(pp) };
}
function shuffleTable(rows: Array<{ name: string; m: Metrics; ci?: { auc: [number, number]; ap: [number, number] } }>): string[] {
  const lines = ['| Method | ROC-AUC (95% CI) | Average precision (95% CI) | Precision@10 | NDCG@10 |', '|---|---:|---:|---:|---:|'];
  for (const r of rows) lines.push('| ' + r.name.replace(/\|/g, '\\|') + ' | ' + fmt(r.m.auc) + (r.ci ? ' (' + fmt(r.ci.auc[0]) + '–' + fmt(r.ci.auc[1]) + ')' : '') + ' | ' + fmt(r.m.ap) + (r.ci ? ' (' + fmt(r.ci.ap[0]) + '–' + fmt(r.ci.ap[1]) + ')' : '') + ' | ' + fmt(r.m.p10) + ' | ' + fmt(r.m.ndcg10) + ' |');
  return lines;
}
async function embedAll(votes: Vote[], o: Options, db: Database.Database, digest: string): Promise<{ vectors: Map<string, Map<Variant, number[]>>; generated: number; hits: number }> {
  db.exec('CREATE TABLE IF NOT EXISTS vectors (cache_key TEXT PRIMARY KEY, model_digest TEXT NOT NULL, text_hash TEXT NOT NULL, norm_version TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL, created_at TEXT NOT NULL)');
  const get = db.prepare('SELECT vector, dimensions FROM vectors WHERE cache_key = ?');
  const put = db.prepare("INSERT OR REPLACE INTO vectors (cache_key,model_digest,text_hash,norm_version,dimensions,vector,created_at) VALUES (?,?,?,?,?,?,datetime('now'))");
  const vectors = new Map<string, Map<Variant, number[]>>(); const pending: Array<{ vote: Vote; variant: Variant; text: string; key: string; textHash: string }> = [];
  for (const v of votes) { const map = new Map<Variant, number[]>(); vectors.set(v.id, map); for (const variant of variants) {
    const text = v.text[variant.key]; const textHash = hash(text); const key = hash(digest + '\n' + normVersion + '\n' + textHash);
    const row = get.get(key) as { vector: Buffer; dimensions: number } | undefined;
    if (row) map.set(variant.key, Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dimensions)));
    else pending.push({ vote: v, variant: variant.key, text, key, textHash });
  }}
  const hits = votes.length * variants.length - pending.length; const unique = new Map(pending.map((p) => [p.key, p])); const jobs = [...unique.values()]; let generated = 0;
  for (let i = 0; i < jobs.length; i += o.batch) {
    const batch = jobs.slice(i, i + o.batch);
    const tags = await json<{ embeddings?: number[][]; embedding?: number[] }>(o.url + '/api/embed', { model: o.model, input: batch.map((x) => x.text), keep_alive: '30m', truncate: true });
    const result = tags.embeddings ?? (tags.embedding ? [tags.embedding] : []);
    if (result.length !== batch.length) throw new Error('Ollama returned ' + result.length + ' vectors for ' + batch.length + ' inputs.');
    const tx = db.transaction(() => batch.forEach((job, j) => {
      const v = unit(result[j]); const f = Float32Array.from(v); const blob = Buffer.from(f.buffer, f.byteOffset, f.byteLength);
      put.run(job.key, digest, job.textHash, normVersion, f.length, blob); generated++;
    })); tx();
    console.log('Embedded ' + Math.min(i + batch.length, jobs.length) + '/' + jobs.length + ' cache misses');
  }
  for (const v of votes) for (const variant of variants) if (!vectors.get(v.id)!.has(variant.key)) {
    const text = v.text[variant.key]; const textHash = hash(text); const key = hash(digest + '\n' + normVersion + '\n' + textHash);
    const row = get.get(key) as { vector: Buffer; dimensions: number } | undefined;
    if (!row) throw new Error('Missing vector after embedding: ' + v.id);
    vectors.get(v.id)!.set(variant.key, Array.from(new Float32Array(row.vector.buffer, row.vector.byteOffset, row.dimensions)));
  }
  return { vectors, generated, hits };
}
async function main() {
  const o = options(); const loaded = readVotes(o.input); const votes = loaded.votes;
  const pos = votes.filter((v) => v.vote === 1).length; const neg = votes.length - pos;
  if (pos < o.folds || neg < o.folds) throw new Error('Not enough examples for requested folds.');
  console.log('Loaded ' + votes.length + ' unique URLs: ' + pos + ' upvotes, ' + neg + ' downvotes; collapsed ' + loaded.duplicateCount + ' duplicate records; excluded ' + loaded.conflicts + ' contradictory URL groups.');
  console.log('Embedding text variants: title + summary (summary capped at 2,000 chars); same text plus first 1,000 cleaned content chars.');
  let digest = 'name:' + o.model;
  try { const tags = await json<{ models?: Array<{ name?: string; digest?: string }> }>(o.url + '/api/tags'); const found = (tags.models ?? []).find((m) => m.name === o.model || m.name === o.model + ':latest' || m.name?.split(':')[0] === o.model); if (found?.digest) digest = found.digest; } catch { console.warn('Could not read Ollama model digest; cache keyed by model name.'); }
  mkdirSync(dirname(o.cache), { recursive: true }); const db = new Database(o.cache); db.pragma('journal_mode = WAL');
  try {
    const start = Date.now(); const result = await embedAll(votes, o, db, digest);
    console.log('Embeddings: ' + result.generated + ' generated, ' + result.hits + ' cache hits in ' + ((Date.now() - start) / 1000).toFixed(1) + 's; cache: ' + o.cache);
    const folds = splits(votes, o.folds, o.repeats);
    const names = ['Baseline: Current', 'Baseline: Intelligence Next', ...variants.flatMap((v) => (['centroid', 'knn15', 'multicentroid5'] as Method[]).flatMap((m) => [v.key + ' / ' + m, ...[25, 50, 75].map((l) => v.key + ' / hybrid-' + m + '-' + l)]))];
    const oof = new Map(names.map((n) => [n, Array.from({ length: o.repeats }, () => new Array<number>(votes.length).fill(NaN))]));
    const foldStats = new Map(names.map((n) => [n, [] as Metrics[]]));
    for (let r = 0; r < o.repeats; r++) { for (let f = 0; f < o.folds; f++) {
      const testIndices = folds[r][f]; const testSet = new Set(testIndices); const train = votes.filter((_v, i) => !testSet.has(i)); const test = testIndices.map((i) => votes[i]);
      const scored = scoreFold(train, test, result.vectors, 20261025 + r * 1009 + f); const labels = test.map((v) => v.vote);
      for (const name of names) { const s = scored.get(name)!; testIndices.forEach((ix, i) => { oof.get(name)![r][ix] = s[i]; }); foldStats.get(name)!.push(metrics(labels, s)); }
    } console.log('Cross-validation repeat ' + (r + 1) + '/' + o.repeats + ' complete'); }
    const labels = votes.map((v) => v.vote); const prevalence = pos / votes.length;
    const rows = names.map((name, index) => {
      const scores = votes.map((_v, i) => avg(oof.get(name)!.map((repeat) => repeat[i])));
      const ci = bootstrap(labels, scores, o.bootstrap, 991 + index); const fm = foldStats.get(name)!;
      return { name, m: { auc: auc(labels, scores), ap: ap(labels, scores), p10: avg(fm.map((x) => x.p10)), ndcg10: avg(fm.map((x) => x.ndcg10)), prevalence }, ci };
    }).sort((a, b) => { const rank = (n: string) => n.startsWith('Baseline:') ? 0 : n.includes('/ hybrid-') ? 2 : 1; return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name); });
    const cut = Math.floor(votes.length * 0.8); const train = votes.slice(0, cut); const test = votes.slice(cut); const chrono = scoreFold(train, test, result.vectors, 20261025); const chronoLabels = test.map((v) => v.vote);
    const chronoRows = [...chrono.entries()].map(([name, s]) => ({ name, m: metrics(chronoLabels, s) })).sort((a, b) => { const rank = (n: string) => n.startsWith('Baseline:') ? 0 : n.includes('/ hybrid-') ? 2 : 1; return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name); });
    const report = [
      '# FriRSS semantic ranking: real-vote evaluation', '',
      'Generated: ' + new Date().toISOString(), 'Model: ' + o.model, 'Model digest/cache version: ' + digest,
      'Unique articles: ' + votes.length + ' (' + pos + ' upvotes, ' + neg + ' downvotes; positive rate ' + fmt(prevalence) + '). Duplicate URL records collapsed: ' + loaded.duplicateCount + '; contradictory URL groups excluded: ' + loaded.conflicts + '.',
      'Inputs: title + summary (summary capped at 2,000 characters) versus the same input plus the first 1,000 cleaned content characters.',
      'Cache: ' + o.cache + '; newly generated vectors: ' + result.generated + '; cache hits: ' + result.hits + '.', '',
      '## Repeated stratified cross-validation', '',
      o.folds + ' folds × ' + o.repeats + ' repeats. Each article is held out once per repeat. ROC-AUC and average precision use out-of-fold scores averaged across repeats; intervals are 95% class-stratified bootstrap intervals over unique articles. Precision@10 and NDCG@10 are averaged across test folds.',
      'Positive prevalence is ' + fmt(prevalence) + ', so random-ranking Precision@10 is expected to be approximately this value. Higher is better for all reported metrics.', '',
      ...shuffleTable(rows), '', '## Chronological holdout', '',
      'Train on the earliest ' + train.length + ' records (' + train.filter((v) => v.vote === 1).length + ' up / ' + train.filter((v) => v.vote === -1).length + ' down); test on the latest ' + test.length + ' (' + test.filter((v) => v.vote === 1).length + ' up / ' + test.filter((v) => v.vote === -1).length + ' down). This is a sensitivity check, not an independent second experiment.', '',
      ...shuffleTable(chronoRows), '', '## Limitations', '',
      '- This tests upvote-versus-downvote prediction only among articles the existing system surfaced and the reader chose to vote on. It does not directly establish ranking quality across all feed articles; unvoted articles are not negative examples.',
      '- The vote labels are imbalanced and temporally clustered. Consider both uncertainty intervals and the chronological result; a single point estimate is insufficient.',
      '- Current and Intelligence Next are invoked from this repository. The export lacks real publication dates, subscriptions, and saved-item signals, so freshness is neutral and subscription/saved signals are omitted.',
      '- Centroid compares positive and negative mean vectors; kNN uses the 15 nearest training examples; multi-centroid uses up to five deterministic k-means centroids per class. Hybrid blends Intelligence Next and semantic rank percentiles.',
      '- No production server, UI, settings, or ranking behavior is changed.', '',
    ].join('\n');
    console.log('\n' + report);
    if (o.out) { writeFileSync(o.out, report, 'utf8'); console.log('Report saved: ' + o.out); }
  } finally { db.close(); }
}
main().catch((error: unknown) => { console.error('Evaluation failed:', error instanceof Error ? error.message : error); process.exitCode = 1; });

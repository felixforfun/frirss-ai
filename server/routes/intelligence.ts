import { Router } from 'express';
import { createHash } from 'node:crypto';
import db from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// Feedback is keyed by the authenticated user and stable article ID. A vote
// replaces the previous vote; DELETE removes it (the UI's undo action).
db.exec(`
  CREATE TABLE IF NOT EXISTS intelligence_feedback (
    user_id INTEGER NOT NULL,
    article_id TEXT NOT NULL,
    article_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    source_id TEXT NOT NULL DEFAULT '',
    vote INTEGER NOT NULL CHECK (vote IN (-1, 1)),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, article_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_intelligence_feedback_user_vote
    ON intelligence_feedback(user_id, vote);
`);

// Additive migration for databases created before article text was stored.
for (const [column, definition] of [['summary', "TEXT NOT NULL DEFAULT ''"], ['content', "TEXT NOT NULL DEFAULT ''"]] as const) {
  const columns = db.prepare('PRAGMA table_info(intelligence_feedback)').all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec('ALTER TABLE intelligence_feedback ADD COLUMN ' + column + ' ' + definition);
  }
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}

router.get('/feedback', (req, res) => {
  const rows = db.prepare(`
    SELECT article_id AS articleId, article_url AS url, title, summary, content, source_id AS sourceId,
           vote, created_at AS createdAt, updated_at AS updatedAt
    FROM intelligence_feedback WHERE user_id = ?
    ORDER BY updated_at DESC LIMIT 5000
  `).all(req.user.id);
  res.json({ feedback: rows });
});

router.put('/feedback', (req, res) => {
  const body = req.body as Record<string, unknown>;
  if (!validText(body.articleId, 512) || !body.articleId.trim()
    || !validText(body.url, 4096) || !validText(body.title, 2000) || !validText(body.summary, 10000)
    || !validText(body.content, 200000) || !validText(body.sourceId, 512)
    || (body.vote !== 1 && body.vote !== -1)) {
    return res.status(400).json({ error: 'Invalid article feedback', fields: {
      articleId: typeof body.articleId === 'string' ? (body.articleId.trim().length ? 'ok' : 'empty') : 'invalid type',
      url: typeof body.url === 'string' ? (body.url.length <= 4096 ? 'ok' : 'too long') : 'invalid type',
      title: typeof body.title === 'string' ? (body.title.length <= 2000 ? 'ok' : 'too long') : 'invalid type',
      summary: typeof body.summary === 'string' ? (body.summary.length <= 10000 ? 'ok' : 'too long') : 'invalid type',
      content: typeof body.content === 'string' ? (body.content.length <= 200000 ? 'ok' : 'too long') : 'invalid type',
      sourceId: typeof body.sourceId === 'string' ? (body.sourceId.length <= 512 ? 'ok' : 'too long') : 'invalid type',
      vote: body.vote === 1 || body.vote === -1 ? 'ok' : 'invalid value',
    } });
  }

  db.prepare(`
    INSERT INTO intelligence_feedback
      (user_id, article_id, article_url, title, summary, content, source_id, vote, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    ON CONFLICT(user_id, article_id) DO UPDATE SET
      article_url=excluded.article_url, title=excluded.title,
      summary=excluded.summary, content=excluded.content, source_id=excluded.source_id, vote=excluded.vote,
      updated_at=datetime('now')
  `).run(req.user.id, body.articleId.trim(), body.url, body.title, body.summary, body.content, body.sourceId, body.vote);

  res.json({ ok: true, articleId: body.articleId.trim(), vote: body.vote });
});

router.delete('/feedback/:articleId', (req, res) => {
  if (typeof req.params.articleId !== 'string' || req.params.articleId.length > 512) {
    return res.status(400).json({ error: 'Invalid article ID' });
  }
  const result = db.prepare(
    'DELETE FROM intelligence_feedback WHERE user_id = ? AND article_id = ?'
  ).run(req.user.id, req.params.articleId);
  res.json({ ok: true, removed: result.changes > 0 });
});


// ── External discovery signals (contract v2, rework Phase 2) ───────────
import {
  cacheKey, lookupFunctionFor, readSignalCache, runLookup, ttlForSignal,
  schedulers, writeSignalCache,
  type ExternalArticleInput, type ExternalSource, type SignalValue,
} from '../externalSignals.js';
import { buildCohortContext, wikipediaMatcher } from '../wikiPageviews.js';
import { computeCoverage, MAX_CANDIDATES, type ConsensusArticle } from '../consensus.js';

const EXTERNAL_SOURCES = new Set<ExternalSource>(['gdelt', 'github', 'hackerNews', 'lobsters', 'wikipedia']);

interface SignalRequestArticle extends ExternalArticleInput { published?: number }

/**
 * Validate the request body. Contract v2 accepts up to 300 candidates and an
 * optional `published` timestamp (recency priority for rate-limited
 * providers); legacy v1 requests (no `version` field) stay capped at 80.
 */
function parseSignalRequest(body: { articles?: unknown; sources?: unknown; version?: unknown }):
  { error: 'invalid' } | { articles: SignalRequestArticle[]; sources: ExternalSource[]; version: 1 | 2 } {
  const version = body.version === 2 ? 2 : 1;
  const maxArticles = version === 2 ? MAX_CANDIDATES : 80;
  if (!Array.isArray(body.articles) || body.articles.length < 1 || body.articles.length > maxArticles
    || !Array.isArray(body.sources) || body.sources.length < 1
    || body.sources.some((source) => typeof source !== 'string' || !EXTERNAL_SOURCES.has(source as ExternalSource))) {
    return { error: 'invalid' };
  }
  const articles: SignalRequestArticle[] = [];
  const seenUrls = new Set<string>();
  for (const raw of body.articles) {
    if (!raw || typeof raw !== 'object') return { error: 'invalid' };
    const item = raw as Record<string, unknown>;
    const published = typeof item.published === 'number' && Number.isFinite(item.published)
      && item.published > 0 && item.published < 1e13 ? Math.round(item.published) : undefined;
    if (typeof item.url !== 'string' || item.url.length > 4096 || !/^https?:\/\//i.test(item.url)
      || typeof item.title !== 'string' || item.title.length > 2000
      || typeof item.summary !== 'string' || item.summary.length > 10000
      || typeof item.content !== 'string' || item.content.length > 12000) {
      return { error: 'invalid' };
    }
    if (seenUrls.has(item.url)) continue; // duplicate/syndicated copies: first occurrence wins
    seenUrls.add(item.url);
    articles.push({ url: item.url, title: item.title, summary: item.summary, content: item.content, published });
  }
  return { articles, sources: [...new Set(body.sources as ExternalSource[])], version };
}

router.post('/external-signals', async (req, res) => {
  const parsed = parseSignalRequest(req.body as { articles?: unknown; sources?: unknown; version?: unknown });
  if ('error' in parsed) return res.status(400).json({ error: 'Invalid external-signal request' });
  const { articles, sources, version } = parsed;
  const context = buildCohortContext(articles);
  const lookup = (source: ExternalSource) => lookupFunctionFor(source, wikipediaMatcher);
  const priorityOf = (article: SignalRequestArticle) => article.published ?? 0;

  // A closed request stops further lookups: v2 cancels its queued jobs, v1
  // exits its synchronous loop early.
  let requestClosed = false;
  req.on('close', () => { requestClosed = true; });
  const enqueued: Array<{ source: ExternalSource; key: string }> = [];

  if (version === 2) {
    // Answer immediately from cache; queue the rest and report them pending.
    const signals: Record<string, Partial<Record<ExternalSource, SignalValue>>> = {};
    const pending = new Set<string>();
    for (const article of articles) {
      const slots: Partial<Record<ExternalSource, SignalValue>> = {};
      let needsPoll = false;
      for (const source of sources) {
        const key = cacheKey(source, article.url);
        const cached = readSignalCache(source, key);
        if (cached.signal) {
          slots[source] = cached.signal;
          continue;
        }
        needsPoll = true;
        if (requestClosed) continue;
        // Fire-and-forget: the answer comes from the next poll. runLookup
        // routes through the scheduler (spacing, budget, breaker) and never
        // caches a cancelled or budget-rejected attempt.
        void runLookup(source, key, article, priorityOf(article), context, lookup(source))
          .then((signal) => { writeSignalCache(key, signal); })
          .catch(() => { /* cancelled or budget-exceeded: nothing cached */ });
        enqueued.push({ source, key });
      }
      signals[article.url] = slots;
      if (needsPoll) pending.add(article.url);
    }
    req.on('close', () => {
      for (const { source, key } of enqueued) schedulers[source].cancel(key);
    });
    return res.json({ version: 2, signals, pending: [...pending], fetchedAt: Date.now() });
  }

  // Legacy v1: resolve synchronously (bounded at 80 articles) and answer with
  // numeric-or-null slots. Absent/failed lookups stay null so an outage can
  // never demote an article.
  const signals: Record<string, Record<ExternalSource, number | null>> = {};
  for (const article of articles) {
    if (requestClosed) break;
    const slots: Record<ExternalSource, number | null> = { gdelt: null, github: null, hackerNews: null, lobsters: null, wikipedia: null };
    await Promise.all(sources.map(async (source) => {
      const key = cacheKey(source, article.url);
      const cached = readSignalCache(source, key);
      if (cached.signal) {
        const signal = cached.signal;
        slots[source] = signal.state === 'measured' ? (signal.value ?? 0)
          : signal.state === 'none' ? 0
          : null; // not-applicable/unavailable
        return;
      }
      const state = await runLookup(source, key, article, priorityOf(article), context, lookup(source));
      writeSignalCache(key, state);
      slots[source] = state.state === 'measured' ? (state.value ?? 0)
        : state.state === 'none' ? 0
        : null;
    }));
    signals[article.url] = slots;
  }
  return res.json({ signals });
});

// ── Publisher-consensus coverage (contract v2, Phase 3) ────────────────

router.post('/coverage', async (req, res) => {
  const body = req.body as { articles?: unknown };
  if (!Array.isArray(body.articles) || body.articles.length < 1 || body.articles.length > MAX_CANDIDATES) {
    return res.status(400).json({ error: 'Invalid coverage request' });
  }
  const articles: ConsensusArticle[] = [];
  const seenUrls = new Set<string>();
  for (const raw of body.articles) {
    if (!raw || typeof raw !== 'object') return res.status(400).json({ error: 'Invalid article' });
    const item = raw as Record<string, unknown>;
    if (typeof item.url !== 'string' || item.url.length > 4096 || !/^https?:\/\//i.test(item.url)
      || typeof item.title !== 'string' || item.title.length > 2000
      || typeof item.summary !== 'string' || item.summary.length > 10000
      || typeof item.publisher !== 'string' || item.publisher.length > 512
      || typeof item.published !== 'number' || !Number.isFinite(item.published)) {
      return res.status(400).json({ error: 'Invalid article fields' });
    }
    if (seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    articles.push({ url: item.url, title: item.title, summary: item.summary, publisher: item.publisher, published: item.published });
  }
  try {
    const result = await computeCoverage(articles);
    return res.json(result);
  } catch {
    // Embedding failures leave nothing cached; the client retries.
    return res.json({ status: 'provider-unavailable', coverage: {}, missing: articles.map((article) => article.url), provider: null });
  }
});

// ── Semantic (soft balanced margin) scores ─────────────────────────────
// An exact port of the audited scorer (server/semanticScoring.ts): bge-m3
// embeddings of clean(title) + "\n" + clean(summary) capped at 5000 chars,
// cosine similarities against the reader's up- and downvoted articles, and a
// temperature-smoothed log-mean-exp margin. Vectors are cached per
// provider/model/preprocessing-version so incompatible configurations never
// reuse each other's embeddings.
import {
  embeddingCacheKey,
  embeddingText,
  softBalancedMarginScore,
} from '../semanticScoring.js';
import { resolveEmbeddingProvider, type EmbeddingProvider } from '../semanticEmbeddings.js';
import { semanticEmbeddingsFor } from '../semanticEmbeddingService.js';

interface SemanticArticleInput { url: string; title: string; summary: string }
const SEMANTIC_MAX_ARTICLES = 300;
/** Bounded, resumable batches: candidates beyond this stay pending for the next request. */
const SEMANTIC_MAX_EMBEDS_PER_REQUEST = 128;
/** Reference (feedback) embeddings are a one-time cost and must stay complete: the audited formula uses each class's FULL set. */
const SEMANTIC_MAX_REF_EMBEDS = 5000;

router.post('/semantic-scores', async (req, res) => {
  const body = req.body as { articles?: unknown };
  if (!Array.isArray(body.articles) || body.articles.length < 1 || body.articles.length > SEMANTIC_MAX_ARTICLES) {
    return res.status(400).json({ error: 'Invalid semantic-score request' });
  }
  const articles: SemanticArticleInput[] = [];
  const seenUrls = new Set<string>();
  for (const raw of body.articles) {
    if (!raw || typeof raw !== 'object') return res.status(400).json({ error: 'Invalid article' });
    const item = raw as Record<string, unknown>;
    if (typeof item.url !== 'string' || item.url.length > 4096 || !/^https?:\/\//i.test(item.url)
      || typeof item.title !== 'string' || item.title.length > 2000
      || typeof item.summary !== 'string' || item.summary.length > 10000) {
      return res.status(400).json({ error: 'Invalid article fields' });
    }
    if (seenUrls.has(item.url)) continue; // duplicate/syndicated copies: first occurrence wins
    seenUrls.add(item.url);
    articles.push({ url: item.url, title: item.title, summary: item.summary });
  }

  const provider = resolveEmbeddingProvider();
  if (!provider) {
    // No provider configured: the current ordering stands; nothing is cached as failed.
    return res.json({ status: 'provider-unavailable', scores: {}, missing: articles.map((article) => article.url), provider: null });
  }

  // Reference classes must be complete (the audited formula aggregates over
  // every upvote and every downvote), so their embeddings are not capped at
  // the per-request candidate limit; they are one-time costs, then cached.
  const rows = db.prepare(
    'SELECT title, summary, content, vote FROM intelligence_feedback WHERE user_id = ? AND vote IN (-1, 1)',
  ).all(req.user.id) as Array<{ title: string; summary: string; content: string; vote: number }>;
  const refJobs = new Map<string, { text: string; vote: number }>();
  for (const row of rows) {
    // The audit embedded title + summary; content only fills in for old
    // feedback rows stored before summaries were captured.
    const text = embeddingText(row.title, row.summary || row.content || '');
    refJobs.set(embeddingCacheKey(provider.model, text), { text, vote: row.vote });
  }
  const refResult = await semanticEmbeddingsFor(
    provider,
    [...refJobs.entries()].map(([key, job]) => ({ key, text: job.text })),
    SEMANTIC_MAX_REF_EMBEDS,
  );
  const refVectorByKey = new Map(refResult.vectors.map((entry) => [entry.key, entry.vector]));
  const positiveRefs: number[][] = [];
  const negativeRefs: number[][] = [];
  for (const [key, job] of refJobs) {
    const vector = refVectorByKey.get(key);
    if (vector) (job.vote === 1 ? positiveRefs : negativeRefs).push(vector);
  }
  if (refResult.failures > 0 || refResult.notAttempted.size > 0 || refVectorByKey.size < refJobs.size) {
    // The provider is configured but the reference embeddings are not all
    // there (outage or still embedding). The audited formula aggregates over
    // every class member, so partial references must not be scored against:
    // this status is retryable with backoff.
    return res.json({ status: 'reference-unavailable', scores: {}, missing: [], provider: provider.id });
  }
  if (!positiveRefs.length || !negativeRefs.length) {
    // Genuine single-class voting history: a stable answer, not a retry.
    return res.json({ status: 'insufficient-feedback', scores: {}, missing: [], provider: provider.id });
  }

  const scores: Record<string, number> = {};
  const missing: string[] = [];
  const candidateJobs = articles.map((article) => {
    const text = embeddingText(article.title, article.summary);
    return { article, text, key: embeddingCacheKey(provider.model, text) };
  });
  const candidateResult = await semanticEmbeddingsFor(provider, candidateJobs, SEMANTIC_MAX_EMBEDS_PER_REQUEST);
  const vectorByKey = new Map(candidateResult.vectors.map((entry) => [entry.key, entry.vector]));
  const refVectors = [...positiveRefs, ...negativeRefs];
  for (const job of candidateJobs) {
    const vector = vectorByKey.get(job.key);
    if (!vector) { missing.push(job.article.url); continue; }
    const sims = refVectors.map((ref) => {
      let dot = 0;
      const length = Math.min(vector.length, ref.length);
      for (let index = 0; index < length; index++) dot += vector[index] * ref[index];
      return dot;
    });
    const score = softBalancedMarginScore(
      sims.slice(0, positiveRefs.length),
      sims.slice(positiveRefs.length),
    );
    if (score === null) missing.push(job.article.url);
    else scores[job.article.url] = score;
  }
  const status = missing.length ? (Object.keys(scores).length ? 'partial' : 'no-scores') : 'ok';
  res.json({ status, scores, missing, provider: provider.id });
});

export default router;
